# ADR 0008 — Rotinas de manutenção com pg_cron

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O base-app tem só duas rotinas fora de requisição, e ambas são expurgo de dados: eventos de
auditoria com mais de 12 meses e chaves de idempotência vencidas (24 h). Funções da Vercel não
são processos longos, então um agendador em processo não funciona. Expor uma rota de cron
protegida por segredo estático cria superfície de ataque e um segredo a girar, só para apagar
linhas de uma tabela.

## Decisão

- O **`pg_cron`** do Supabase executa três rotinas, agendadas por migration em horário de baixo
  uso (UTC): `ops.purge_expired()` **uma vez por dia**, `ops.purge_unconfirmed_users()` uma vez
  por dia e `ops.check_signals()` a cada 15 minutos.
- `ops.purge_expired()` é `SECURITY DEFINER`, com `search_path` fixo, e apaga:
  - `audit.events` com mais de 12 meses;
  - `platform.idempotency_keys` com `expires_at` vencido.
- A execução é idempotente, apaga em **lotes de 5 000 e no máximo 20 lotes por tabela por
  execução** (o backlog maior termina nos dias seguintes) e não é executável por `api_runtime`
  nem pelos papéis `*_system` (pgTAP confere). O SQL está em
  account-lifecycle-and-privacy.md §4.1.
- O resultado (contagem apagada por tabela) vai para `audit.events` com ação
  `ops.purge_expired`, sem dado pessoal, **sempre**, mesmo com zero apagado: é o sinal de vida.
- `ops.purge_unconfirmed_users()` (dona `auth_fn_owner`) apaga em lotes de 500 as contas não
  confirmadas com mais de 3 dias e grava o evento `ops.purge_unconfirmed_users` com a contagem.
- **Alertas (mecanismo concreto).** `ops.check_signals()` grava em `ops.alerts` (código, valor,
  hora) e, se o Vault tiver `ALERT_RESEND_API_KEY`, `ALERT_TO` e `ALERT_FROM`, envia ao operador um e-mail com
  `pg_net` pela API do Resend (chave só de envio, no header `Authorization`, sem dado pessoal;
  um alerta por código a cada 6 h). Sinais: (1) `cron.job_run_details` com falha nas últimas 24 h;
  (2) sem evento `ops.purge_expired` há mais de 36 h; (3) e-mails de login na última hora acima
  de 70% e de 90% de `email_sent`; (4) contas não confirmadas acima de 1 000; (5) volume de
  `audit.events` por `actor_type` na hora (`operator` > 50, `system` > 1 000, `webhook` > 2 000); (6) evento `app_config.updated` com
  `actor_type = 'operator'` numa chave que **não** está em `app_config.operator_alert_exempt_keys`
  (a allowlist de chaves por papel não é imposta no banco; este alerta é a mitigação parcial,
  risco R27).
  `ALERT_FROM` é o remetente verificado no Resend, fornecido pelo operador: não há
  remetente inventado nem derivado automaticamente do domínio de exemplo. Os três
  valores são configuração externa, sem valores no repositório. Sem qualquer um
  deles, o alerta é persistido localmente e a entrega não é tentada nem marcada
  como enviada. Os testes locais usam uma porta de transporte falsa; não enviam e-mail.
  Se o `pg_cron` morrer, o alerta morre com ele: risco R23, coberto por conferência semanal no
  runbook.
- **O base-app não tem jobs na Vercel:** sem `vercel.json` com `schedules` ou `crons`, sem
  pasta `apps/web/src/jobs/`, sem filas.
- A exclusão de conta é **imediata e síncrona** (`AccountDeletionPolicy = immediate`), então
  não precisa de job para executar exclusões vencidas.

## Estado de implementação da onda 2

- A baseline agenda `ops.purge_expired()` e `ops.check_signals()`. O agendamento de
  `ops.purge_unconfirmed_users()` fica bloqueado até a aprovação do caminho mínimo para gravar
  a contagem na auditoria: `auth_fn_owner` não tem `INSERT` em `audit.events`, e não recebeu
  grant, associação ou helper novo.
- `ops.check_signals()` implementa falhas recentes do cron, ausência do evento de expurgo,
  volume de auditoria por `actor_type` e alteração de configuração por operador fora da lista
  isenta. Os sinais de backlog de contas não confirmadas e volume de e-mails não entram ainda:
  eles dependem de um caminho de leitura sem ampliar o acesso de `ops` a `auth.*` e da lista
  fechada de ações de e-mail do spike S-AU-4, respectivamente.
- `pg_net` é assíncrono. A função guarda o ID da requisição e marca `last_sent_at` apenas quando
  lê uma resposta HTTP 2xx sem timeout em `net._http_response`; o retorno 2xx comprova que a API
  do Resend aceitou a requisição, não que a mensagem chegou à caixa do operador. Sem qualquer
  um dos três segredos de Vault (`ALERT_RESEND_API_KEY`, `ALERT_TO`, `ALERT_FROM`), o alerta
  fica persistido e não é enfileirado nem marcado como enviado.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Vercel Schedules | Exigiria uma função, autenticação do disparo e estado beta do recurso, para uma rotina que é puro SQL |
| Cron do GitHub Actions | Precisaria de credencial de banco no CI e não é confiável para horário (atrasos e desativação em repositório inativo) |
| Rota pública com `CRON_SECRET` | Superfície de ataque e segredo estático para girar |

## Consequências

- Os alertas dependem de `pg_net` e do Supabase Vault (extensões habilitadas por migration);
  localmente `ops.alerts` basta para o pgTAP.
- O expurgo depende da extensão `pg_cron` do Supabase; fica habilitada por migration e o
  pgTAP confere o agendamento.
- **Versões derivadas** que precisem de jobs criam `apps/web/src/jobs/` e os agendam como
  quiserem (extensão, ADR 0013). O base-app não deixa estrutura vazia para isso.
- A retenção é uma regra no banco e se aplica mesmo que a API esteja fora do ar.
