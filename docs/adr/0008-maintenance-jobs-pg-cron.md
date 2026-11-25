# ADR 0008 — Rotinas de manutenção com pg_cron

- **Status:** accepted — revisado pelo ADR 0016 em 2026-11-25
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
- `ops.purge_unconfirmed_users()` pertence a `ops` e chama helpers fixos do núcleo
  pertencentes a `postgres`: contagem e exclusão de contas por e-mail não confirmadas
  há mais de 3 dias, em lotes de 500. Contas anônimas, confirmadas e recentes são
  preservadas. O wrapper grava a contagem em auditoria, na mesma transação; não
  há grant direto de Auth para `ops` nem identificador pessoal no evento.
- **Alertas persistidos.** `ops.check_signals()` grava código, valor e horário em
  `ops.alerts`. A baseline não instala `pg_net`, não lê credenciais no Vault e não
  envia e-mail. Sinais: (1) falhas de cron nas últimas 24 h; (2) ausência do evento
  `ops.purge_expired` por mais de 36 h; (3) contas não confirmadas acima de 1 000;
  (4) volume por `actor_type` na hora (`operator` > 50, `system` > 1 000,
  `webhook` > 2 000); (5) `app_config.updated` por `operator` em chave fora de
  `operator_alert_exempt_keys` (mitigação parcial de R27).
  O sinal de e-mail em 70%/90% de `email_sent` só entra após S-AU-4 identificar
  os eventos que representam envio. Não se inventa esse mapeamento na W2.
- **Operação do derivado.** Até existir um monitor externo especificado, o operador
  consulta `ops.alerts` e o sinal de vida do expurgo pelo runbook. Persistir um
  sinal não comprova notificação nem entrega de e-mail. Se `pg_cron` morrer, a
  própria verificação para: risco R23. Um notificador futuro mantém a credencial
  fora do banco e exige spec/ADR próprio; não se adiciona um job nesta onda.
- **O base-app não tem jobs na Vercel:** sem `vercel.json` com `schedules` ou `crons`, sem
  pasta `apps/web/src/jobs/`, sem filas.
- A exclusão de conta é **imediata e síncrona** (`AccountDeletionPolicy = immediate`), então
  não precisa de job para executar exclusões vencidas.

## Revisão da baseline em 2026-11-25

O ADR 0016 substitui a tentativa de grants de Auth para `auth_fn_owner` e o
transporte por `pg_net`. O Supabase documenta que as ACLs gerenciadas da fila
não podem isolar seus headers dos demais logins. A baseline nova mantém
somente o estado dos alertas; não remove extensões, filas ou webhooks de um
banco existente. Essa remoção exige um plano e autorização do operador.

As três rotinas e seus agendamentos precisam de pgTAP, incluindo contagens,
zero linhas, lotes, negativas de execução e rollback da auditoria. Falhas da
baseline anterior permanecem como evidência histórica até a nova execução.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Vercel Schedules | Exigiria uma função, autenticação do disparo e estado beta do recurso, para uma rotina que é puro SQL |
| Cron do GitHub Actions | Precisaria de credencial de banco no CI e não é confiável para horário (atrasos e desativação em repositório inativo) |
| Rota pública com `CRON_SECRET` | Superfície de ataque e segredo estático para girar |

## Consequências

- Alertas persistidos não dependem de credenciais de envio. A ausência de entrega
  automática é um limite operacional explícito do template (ADR 0016).
- O expurgo depende da extensão `pg_cron` do Supabase; fica habilitada por migration e o
  pgTAP confere o agendamento.
- **Versões derivadas** que precisem de jobs criam `apps/web/src/jobs/` e os agendam como
  quiserem (extensão, ADR 0013). O base-app não deixa estrutura vazia para isso.
- A retenção é uma regra no banco e se aplica mesmo que a API esteja fora do ar.
