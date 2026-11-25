# Referência

| Documento | Conteúdo | Situação |
|-----------|----------|----------|
| `openapi.yaml` | Contrato da API, **gerado** de `packages/contracts` por `pnpm contracts:openapi`. Não edite à mão (ADR 0007) | onda 0 |
| `product-config.md` | Cada campo do `product.config.ts` | onda 15 |
| `environment-variables.md` | Variáveis de ambiente detalhadas por app e por ambiente | onda 15 |

## Variáveis de ambiente previstas

Só nomes e papéis, nunca valores. Os nomes de variável do app e da API são os mesmos nos três
ambientes (local, staging, production). A API valida todas no boot e não sobe se faltar uma
(`platform/env`, Zod). Os nomes finais são fixados na onda 0; a tabela abaixo é a previsão a
partir de [specs/base-app.md](../specs/base-app.md).

| Variável | Onde é usada | Segredo? |
|----------|--------------|----------|
| `SUPABASE_URL` | API (JWKS, `iss`) e app | Não |
| `SUPABASE_PUBLISHABLE_KEY` | App (Supabase Auth) e API | Não (pública por desenho) |
| `APP_HOST` | API (middleware de borda: host principal, sem esquema, por ambiente; host desconhecido → 404) | Não |
| `DATABASE_URL` | API (usuário `api_runtime`, pooler em modo transação) | **Sim** |
| `DATABASE_CA_CERT` | API (CA para TLS verificado) | Não |
| `REVENUECAT_SECRET_KEY` | API (API REST v2: ler cliente, excluir cliente) | **Sim** |
| `EXPO_PUBLIC_REVENUECAT_IOS_KEY` | App (SDK do RevenueCat, iOS) | Não (pública por desenho) |
| `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` | App (SDK do RevenueCat, Android) | Não (pública por desenho) |
| `UPSTASH_REDIS_REST_URL` | API (rate limit, cota, cache do RevenueCat) | Não |
| `UPSTASH_REDIS_REST_TOKEN` | API | **Sim** |
| `RESEND_API_KEY` | API (e-mail de conta excluída) | **Sim** |
| `AUDIT_SUBJECT_KEY` | API (HMAC do `subject_ref` em `audit.events`) | **Sim** |
| `REDIS_VALUE_SIGNING_KEY` | API (HMAC do cache de entitlements no Redis; ≥ 32 bytes) | **Sim** |
| `REVENUECAT_PROJECT_ID` | API (conferido contra `product.config.ts` no boot) | Não |
| `<NOME>_EXPIRES_AT` | API (validade do segredo anterior de um webhook, quando há lista de segredos; no máximo 30 dias à frente) | Não |
| `NEXT_PUBLIC_*` (extensões) | Web, só as declaradas em `SiteExtension.publicEnv`; nunca com `SECRET`, `KEY_PRIVATE` ou `TOKEN` no nome | Não (públicas) |
| `SENTRY_DSN` | API | Não (identificador de projeto, tratar como configuração) |
| `EXPO_PUBLIC_SENTRY_DSN` | App | Não |
| `EXPO_PUBLIC_API_URL` | App (base da API) | Não |
| `SMTP_HOST` (`config.toml`: `env(...)`) | Supabase Auth, host SMTP por ambiente | Não |
| `RESEND_SMTP_PASSWORD` (`config.toml`: `env(...)`) | Supabase Auth, senha SMTP | **Sim** |
| `SUPABASE_DB_URL_MIGRATOR` | Pipeline autorizado do derivado: conexão de migration como `postgres` (ADR 0016) | **Sim** |
| `SUPABASE_ACCESS_TOKEN` | CI: `supabase config push` | **Sim** |
| `EXPO_TOKEN` | CI: token de robô do EAS | **Sim** |

Observações:

- Variáveis `EXPO_PUBLIC_*` vão para o bundle do app e **nunca** guardam segredo. Extensões
  declaram as próprias em `MobileExtension.publicEnv` (só `EXPO_PUBLIC_*`) e `SiteExtension.publicEnv`
  (só `NEXT_PUBLIC_*`); o núcleo recusa outro prefixo e nomes com `SECRET`, `KEY_PRIVATE` ou `TOKEN`.
- Alertas do banco são persistidos em `ops.alerts`; o template não pede credenciais
  de envio nem as guarda no Vault/pg_net (ADRs 0008/0016).
- A secret key do Supabase **não existe** no runtime da API (ADR 0004).
- Gates rodam localmente ou na KVM (ADR 0015), sem GitHub Actions. Credenciais de
  operação ficam no ambiente/gerenciador do operador. No derivado hospedado na
  Vercel, segredos da API são separados por ambiente; os de produção são Sensitive.
- Extensões declaram as próprias variáveis (`ServerExtension.env`), validadas no boot junto
  com as do núcleo.
