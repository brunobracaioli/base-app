# ADR 0016 — Baseline do template compatível com o Supabase

- **Status:** accepted — decisão do dono em 2026-11-25; implementação e gates W2 ainda pendentes
- **Data:** 2026-11-25
- **Revisa:** ADRs 0005/0008/0013, base-app §3.8, specs de Auth/configuração/privacidade, threat model e a regra correspondente do AGENTS.md.

## Contexto

O template deve ser configurável por quem clona o repositório. A baseline
atual foi testada em Docker: o reset passa, mas o pgTAP encontra grants de
Auth e revogações de schemas gerenciados que `postgres` não pode aplicar.
Não se trata de falta de uma credencial do operador.

O Supabase documenta funções pequenas pertencentes a `postgres` como caminho
suportado para leituras de Auth por papéis customizados. Também documenta que
qualquer login do banco alcança as filas de `pg_net`; cabeçalhos com uma chave
Resend não ficam isolados por nossos REVOKEs.

- [Permissões do Auth](https://supabase.com/kb/troubleshooting/permission-errors-when-granting-custom-roles-access-to-the-auth-schema-9e32e7)
- [ACLs de pg_net](https://supabase.com/kb/troubleshooting/revoking-access-to-pg_net-objects-has-no-effect-0bbc16)

## Decisão

Manter Data API desligada, papéis por contexto, `api_runtime` sem herança,
RLS forçado nas tabelas da aplicação, TLS, auditoria e validação. Substituir
somente as partes incompatíveis abaixo.

| Operação W2 | Proprietário | Chamador permitido |
| --- | --- | --- |
| `identity.before_user_created(jsonb)` | `postgres` | `supabase_auth_admin` |
| `identity.count_unconfirmed_users()` | `postgres` | `ops` |
| `identity.delete_unconfirmed_users()` (máximo de 500 contas por chamada) | `postgres` | `ops` |
| `ops.purge_unconfirmed_users()` e `ops.check_signals()` | `ops` | `postgres`/agendador |
| `ops.app_config_change_count_last_hour()` (contagem escalar de `app_config.updated` na última hora) | `ops` | `app_config_admin` |

As três funções Auth têm SQL fixo, relações qualificadas, `search_path` vazio,
owner `postgres` e EXECUTE revogado de `PUBLIC` e dos demais papéis. O registry
`supabase/tests/core-auth-fn-registry.json` vincula schema, nome, assinatura,
migration definidora, owner, chamadores e propósito; pgTAP confere também ACLs
negativas. O registry é fechado às três funções W2: extensões não podem criar,
transferir ou registrar funções que toquem em `auth`. Funções de privacidade e
limpeza de senha continuam nas ondas próprias; a onda correspondente adiciona
suas entradas exatas ao registry fechado com a revisão de ameaça e os testes da
spec, sem autorização genérica para extensões.

O wrapper `ops` grava a contagem de purga com seu grant de auditoria já
existente. `app_config_admin` recebe somente a função escalar de contagem,
continuando sem SELECT direto dos eventos.

### Limite concorrente de cadastro

Uma contagem de contas seguida de aprovação do hook não garante o teto sob
concorrência. `identity.signup_reservations` armazena apenas `reservation_id`
(UUID opaco) e `reserved_at`, sem usuário, e-mail ou IP. Sob um advisory lock
transacional fixo, o hook expurga reservas vencidas, conta a janela móvel de
uma hora e insere a reserva na mesma seção crítica; apenas 300 chamadas do hook
podem ser aprovadas nessa janela. O hook valida o objeto e `user`, mas não
depende de `user.email`, para aceitar contas anônimas sem e-mail. Evento
malformado, lock/consulta que excede o limite ou falha de banco não libera o
cadastro. A versão Auth `v2.198.0` invoca o hook fora da transação que cria o
usuário; a fonte fixada está em
[`signup.go`](https://github.com/supabase/auth/blob/v2.198.0/internal/api/signup.go)
e [`hooks.go`](https://github.com/supabase/auth/blob/v2.198.0/internal/api/hooks.go).
Assim, falhas posteriores do Auth e retries consomem uma vaga por até uma hora;
o teto conta aprovações do hook, não contas concluídas, e não deduplica retries.

### Alertas e superfícies gerenciadas

A baseline nova não instala nem envia credenciais por `pg_net`. `ops.alerts`
persiste os sinais; entrega externa de e-mail é um ponto operacional a
desenhar/documentar para o derivado, com credencial fora do banco. O sinal de
volume de e-mail depende do mapeamento S-AU-4 e não é inventado.

As provas de privilégio distinguem tabelas da aplicação de objetos gerenciados
pelo provedor. Mantêm ACLs exatas, RLS e negativas funcionais no app; para
Storage/Realtime verificam configuração desabilitada, ausência de buckets/uso
da aplicação e a fronteira acessível, sem afirmar que um `REVOKE` sem efeito
removeu ACLs do Supabase.

### Histórico de migrations

Para este template ainda não publicado, consolidar a baseline
experimental em migrations novas e coerentes, preservando seu histórico no
Git. Isso exige autorização explícita como exceção à imutabilidade dos
arquivos já aplicados em laboratórios descartáveis. Não autoriza alterar
banco existente. Projetos que já aplicaram a baseline antiga exigem plano de
migração próprio; não se remove `pg_net`, filas ou webhooks de um projeto
existente automaticamente. A migration consolidada exige `current_user = postgres`,
não encontra o papel legado `api_runtime` nem a extensão `pg_net`, e não encontra
as credenciais de alerta antigas em `vault.secrets`; se uma checagem não puder
ser feita, ela falha com orientação para inspeção e migration separada. Nenhum
`DROP EXTENSION` ou cleanup remoto é executado.

## Provas exigidas antes de concluir a onda 2

- Reset e suíte pgTAP completos, sem fixtures que concedam grants ausentes nas migrations.
- Hook sob o papel real de Auth e teste concorrente do teto; entrada inválida e cota esgotada falham fechadas.
- Matriz exata de proprietário/assinatura/EXECUTE/search_path e negação de chamada pelos papéis de runtime.
- Purga preserva contas recentes, confirmadas e contas anônimas; registra somente contagens, na mesma transação.
- CAS, cota de configuração, auditoria atômica e rollback passam sem SELECT direto de auditoria pelo escritor.
- Nenhum segredo em filas de banco; instalação em projeto existente falha com instrução explícita quando não há precondições seguras.
- Código, contratos, tipos e checks do template passam sem criar conta hospedada nem publicar app.

## Consequências e risco residual

O definidor `postgres` possui autoridade maior que o papel restrito originalmente
planejado. A redução do risco vem da superfície pequena, SQL fixo, validação,
allowlist e revisão/testes; não de um grant impossível. GUCs vinculam a operação
à transação, mas não autenticam o chamador. A autorização do usuário continua na
API, baseada em JWT verificado e na capacidade de purga quando ela for implementada.

Esta decisão aprova somente o desenho e a consolidação da baseline inédita do
template. Não autoriza alteração de banco Supabase existente, remoção de
extensões, criação de projeto hospedado nem publicação. A onda 2 permanece
pendente até os gates acima passarem.
