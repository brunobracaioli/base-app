# ADR 0009 — Observabilidade

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

Logs com `print`, arquivos de log commitados e corpos de requisição gravados inteiros são a
forma mais comum de vazar tokens em projetos de iniciantes. O método pede logs estruturados,
correlation ID, métricas nas operações críticas e nenhuma PII.

O base-app não recebe webhooks e não tem jobs na Vercel (ADRs 0006 e 0008), então a
observabilidade cobre só a API, o app e as rotinas do banco.

## Decisão

- **Logs da API:** pino em JSON, nível por ambiente, com **redaction por padrão de nome**:
  qualquer chave cujo nome contenha `token`, `secret`, `password`, `authorization`, `cookie`,
  `code`, `email` ou `signature` é substituída antes de escrever. Isso cobre `access_token`,
  `refresh_token`, `Authorization` e o código de login. Campos padrão: `requestId`, `userId`
  (UUID), `route`, `method`, `status`, `durationMs`, `outcome`, `errorCode`. **Corpos de
  requisição não são logados.** `console.*` é proibido (lint). A mensagem do log é sempre um
  literal (lint `no-dynamic-log-message`); valores vão em campos. Um filtro final troca e-mails e
  strings com forma de JWT que sobrem em texto livre. Erro de driver registra só `name` e `code`
  (SQLSTATE), nunca a `message`.
- **Dado pessoal em logs:** só o UUID do usuário, dado pseudônimo, nunca e-mail, nome, token ou
  código. Base legal: legítimo interesse em segurança, prevenção a fraude e estabilidade (LGPD art.
  7º, IX). **Retenção máxima: 30 dias nos logs e 90 dias no Sentry** (a plataforma pode reter
  menos). O UUID some dos logs pela retenção, não pela purga por titular (exceção declarada a
  PR-N1 e PR-N5).
- **Correlation ID:** a API gera o próprio `requestId` (UUID v7) em toda requisição; devolve no
  header `X-Request-Id`, grava em `audit.events.correlation_id` e propaga nas chamadas de saída.
  O `X-Request-Id` enviado pelo app, se for UUID válido, é registrado como `clientRequestId` (liga
  o breadcrumb do app ao log) e nunca vira correlação de auditoria. O
  `x-vercel-id` também é registrado.
- **Traces:** OpenTelemetry com `@vercel/otel`, com spans para Postgres, RevenueCat e Redis.
- **Métricas** (Vercel Custom Metrics): latência e taxa de erro por rota, falhas de
  autenticação (401), respostas 429, consultas ao RevenueCat (acerto de cache, erro, latência),
  exclusões de conta executadas e com falha, falhas da rotina `ops.purge_expired`.
- **Erros:** Sentry no app e na API com `sendDefaultPii: false` e `beforeSend` que aplica a
  mesma redaction e descarta corpo de requisição; usuário identificado só pelo UUID.
- **Auditoria:** `audit.events`, só inserção, para operações sensíveis (exclusão de conta,
  exportação, cancelamento de exclusão, mudança de configuração), com retenção de 12 meses
  (ADR 0008). Sem PII; na exclusão o `user_id` vira `subject_ref` (HMAC com
  `AUDIT_SUBJECT_KEY`).
Troca de e-mail e de senha vão direto ao Supabase Auth, não passam pela API e **não** entram em
  `audit.events`; o log de auditoria do próprio Auth as cobre.
- **Alertas:** taxa de 5xx acima de 2% em 5 min; pico de 401; exclusão de conta com falha
  (`privacy.deletion_unavailable` > 3 em 5 min); RevenueCat indisponível; erro
  `over_email_send_rate_limit` (3 em 10 min, Sentry); e os sinais do banco de `ops.check_signals()`
  (falha do `pg_cron`, volume de e-mail, volume de auditoria; ADR 0008).
- **Extensões** herdam o logger, o redaction e o audit; nenhuma configura o próprio.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Só o log padrão da Vercel | Retenção curta e sem estrutura |
| Datadog ou Grafana Cloud | Mais completos, mais caros para um template; o OpenTelemetry permite trocar o destino depois por log drain ou exporter |

## Consequências

- Um teste de redaction garante que nenhum campo sensível aparece no log nem no evento do
  Sentry, usando corpos reais de login, troca de senha e exportação.
- A retenção dos logs segue o plano da Vercel; o que precisa durar vai para `audit.events`.
- Nomes de campo que casem com o padrão são sempre redigidos, inclusive os inofensivos (um
  campo `postcode` seria redigido). É o preço de uma regra simples e segura; quem precisar
  logar o valor renomeia o campo.
- Versões derivadas que recebem webhooks acrescentam a remoção de headers das rotas de webhook
  no `beforeSend` do Sentry.
