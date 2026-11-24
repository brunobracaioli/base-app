# ADR 0013 — Núcleo extensível

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O base-app é gratuito e público (licença MIT). Ele também é o **núcleo** de versões derivadas:
produtos que partem deste repositório e acrescentam módulos (por exemplo, outros métodos de
login, outra forma de conferir assinaturas, jobs, painel administrativo). Alunos que criam
forks do template têm a mesma necessidade em escala menor.

Duas exigências puxam em direções opostas:

1. Uma correção de segurança no base-app deve chegar às versões derivadas sem retrabalho.
2. O código de uma versão derivada não pode estar no repositório público.

## Decisão

### Modelo de merge

- A versão derivada é um **clone** do base-app, em repositório próprio, com
  `git remote add upstream <base-app>`.
- Ela recebe as atualizações com `git fetch upstream && git merge upstream/main`. Merge, não
  rebase: o histórico já publicado não é reescrito.
- O código da versão derivada nunca entra no base-app. O base-app não referencia nenhuma
  versão derivada (nem em nomes, flags ou comentários).
- Toda mudança de que uma extensão precise e que não caiba nos pontos abaixo é feita **primeiro
  no base-app**, como ponto de extensão genérico, e chega à versão derivada pelo merge.

### Pontos de extensão

Os pontos são os da spec principal, §3.4.1. Resumo:

| Camada | Ponto |
|--------|-------|
| API: módulos | `apps/web/src/extensions/index.ts` exporta `serverExtensions: ServerExtension[]`. Cada extensão declara nome, schema de env, papéis de sistema e `register(registry)` |
| API: substituição de portas | `registry.override` de `EntitlementsReader`, `AccountDeletionPolicy` (`request`, `cancel`, `getPending`), `EmailSender` e `AuthorizationPolicies`; uma porta só pode ser substituída uma vez (senão o boot falha). `EntitlementsReader` é só `read(userId, { fresh })` |
| API: borda | `apps/web/src/extensions/edge.ts` exporta `edgeExtensions: EdgeExtension[]`: host dedicado com `pathPrefixes`, acréscimos de CSP por prefixo, `csp[].strict` (CSP estrita com `trusted-types`, por prefixo) e `headers` que só endurecem (`Referrer-Policy: no-referrer`, COOP e CORP `same-origin`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`). Só dados, sem Node; o `matcher` cobre todos os paths (inclusive `/_next/**`); host desconhecido e path fora do prefixo dão 404; caminho é normalizado antes de comparar; o teste da CSP recusa `*`, `unsafe-*`, `data:` e `blob:` e exige `https://<host>` em toda diretiva |
| API: eventos | `registry.onEvent`, inclusive `AccountPurgeRequested` |
| API: rotas | arquivos novos em `apps/web/src/app/api/v1/<extensão>/**/route.ts` |
| API: manutenção | `maintenance: 'exempt'` no `defineRoute` | só para `auth.kind: 'webhook'` ou rota com política registrada com `{ operator: true }`; qualquer outro uso falha no boot e no teste estático |
| API: webhooks | `auth: { kind: 'webhook', verifier }` no `defineRoute`, com os verificadores `sharedSecret(envNames)` e `standardWebhooks(envNames)` do núcleo (lista de variáveis, para rotação sem janela). `rateLimit.key` aceita `'global'` e há `maxBodyBytes` por rota (padrão 32 KB, máximo 1 MB). Schemas de payload de emissor autenticado, em `packages/contracts/src/**/webhooks/**`, usam `.strip()` em vez de `.strict()` |
| API: auditoria e configuração | papéis-grupo `audit_writer` (insere em `audit.events` só `system` e `webhook`), `audit_operator_writer` (insere só `operator`; um painel recebe os dois), `audit_reader` (só `select`, para a tela de auditoria de um painel; a leitura é auditada pelo painel) e `app_config_writer` (só `execute` em `app_config.set_setting`); `platform/audit` exporta `recordAuditEvent` e `subjectRef`; `modules/app-config/index.ts` exporta `APP_CONFIG_KEYS` e `appConfigValueSchemas`. A extensão ganha o papel por `grant`; nenhuma cria política em `audit.events` |
| API: contexto de auth, exclusão e cotas | `AuthContext` com `isAnonymous`, `appRoles` e `providers`; `verifyAccessToken` público; `purgeAccount` em `modules/privacy/index.ts`, que só aceita uma `PurgeAuthorization` (fábricas do módulo, jobs registrados por `registerPurgeJob`) e só pode ser importada por `modules/privacy/**` e `extensions/**` (ESLint); `consumeDailyQuota` e `refundDailyQuota` em `modules/billing/index.ts` |
| API: jobs | pasta nova `apps/web/src/jobs/` (não existe no base-app) |
| Banco | migrations com schema próprio; nunca alterar tabela do núcleo; dado extra do usuário em tabela 1:1 com FK para `auth.users` (ADR 0005) |
| Contratos | `packages/contracts/src/extensions/index.ts` |
| Configuração | `packages/config/src/extensions.ts` (`extensionConfigSchema`, `extensionAuthMethods`) e o bloco `extensions` do `product.config.ts` (ADR 0010) |
| App: fachada | `apps/mobile/src/extensions/api.ts` | `extensionAuth` (inclui `withPreviousSession`), `useSessionSummary`, `extensionApiClient`, `SettingsItemProps`; é a única porta das extensões para autenticação, sessão e API do núcleo |
| App | `apps/mobile/src/extensions/index.ts` exporta `mobileExtensions: MobileExtension[]` (métodos de login com `AuthMethodProps` mínimo, gates de boot com `SessionSummary` sem tokens, itens de Configurações, providers, namespaces de i18n, provedor de CAPTCHA, `publicEnv` com `EXPO_PUBLIC_*`); rotas em `apps/mobile/src/app/(ext)/**` |
| i18n | um arquivo por namespace: `shared/i18n/locales/<idioma>/<namespace>.json` |
| Site | páginas novas em `apps/web/src/app/(site)/**` ou num grupo próprio; `apps/web/src/extensions/site.tsx` exporta `siteExtensions: SiteExtension[]` (widget de CAPTCHA da página `/account-deletion`, `publicEnv` com `NEXT_PUBLIC_*`) |
| Supabase | fragmentos `supabase/config.d/<NN>-<nome>.toml`, mesclados ao `config.base.toml` num `config.toml` gerado (ADR 0014) |
| Testes | pgTAP e testes novos; o teste de purga completa varre o catálogo e cobre as tabelas da extensão sem configuração |

Os arquivos de extensão do base-app são **listas vazias**, e um teste garante que o núcleo
funciona sem extensão nenhuma. Um teste de integração registra uma **extensão falsa** que
acrescenta rota, handler de purga e substituição de porta sem tocar em outro arquivo do núcleo
(critério de aceite da spec principal).

### Fronteiras

Extensões não importam internals de módulos do núcleo. Usam o `index.ts` público dos contextos
e os tipos de `platform/events`. A regra `no-cross-module-internals` do dependency-cruiser cobre
`extensions/**` (spec §3.5).

### Arquivos que podem divergir

Só estes arquivos do núcleo podem ser editados numa versão derivada. Num merge, o conflito
neles se resolve à mão (spec §3.4.3):

| Arquivo | Motivo |
|---------|--------|
| `apps/web/src/extensions/index.ts` | registrar extensões da API |
| `apps/web/src/extensions/edge.ts` | hosts dedicados e CSP das extensões |
| `apps/web/src/extensions/site.tsx` | slots de UI do site (widget de CAPTCHA) |
| `supabase/config.d/*.toml` | fragmentos de configuração do Supabase (arquivos novos) |
| `supabase/config.toml` | gerado por `pnpm supabase:config`; em conflito, regenera-se (ADR 0014) |
| `apps/mobile/src/extensions/index.ts` | registrar extensões do app |
| `packages/contracts/src/extensions/index.ts` | contratos das extensões |
| `packages/config/src/extensions.ts` | schema e métodos de login das extensões |
| `packages/config/src/product.config.ts` | valores do produto |
| `README.md` | identidade da versão derivada |
| `vercel.json` | agendamentos e configuração da plataforma, só com as chaves de topo da allowlist de `pnpm vercel:check` |
| `apps/*/package.json` | dependências das extensões |
| `pnpm-lock.yaml` | regenerado por `pnpm install` |
| `apps/mobile/app.config.ts` | só plugins nativos de SDKs da extensão |

Qualquer outro arquivo do núcleo alterado numa versão derivada é um defeito do núcleo (faltou
ponto de extensão) e vira PR no base-app.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Um repositório só, com feature flags de licença | O código pago estaria no repositório público; a flag não protege nada |
| Pacotes npm privados para os módulos pagos | Rejeitada por agora: complexidade de publicação, versionamento e instalação para alunos (registro, tokens). Os pontos de extensão deixam a porta aberta: um módulo pode virar pacote depois sem mudar o núcleo |
| Fork sem pontos de extensão | Conflitos constantes a cada merge, porque a versão derivada editaria arquivos do núcleo |
| Dois repositórios com cópia periódica | Perde o histórico e o merge; correção de segurança vira trabalho manual |

## Consequências

- **Disciplina no base-app:** só se criam pontos de extensão **genéricos**, sem nome ou
  conhecimento de nenhuma versão derivada, e cada um tem teste (lista vazia, extensão falsa).
  Ponto de extensão sem uso é custo; por isso só entra o que a spec §3.4 lista.
- **O núcleo é uma API pública.** Mudar a assinatura de `ServerExtension`, `MobileExtension`,
  das portas substituíveis ou de `defineRoute` é mudança incompatível: nota no CHANGELOG e, se
  quebrar extensões, bump de versão maior.
- **Teste de CI de merge na versão derivada:** o pipeline dela faz um merge de teste de
  `upstream/main` (em branch descartável), roda o CI completo e falha se algum arquivo fora da
  lista acima tiver conflito. Detecta cedo um ponto de extensão que faltou.
- `docs/reference/openapi.yaml` e o arquivo de tipos Kysely gerado (`pnpm db:types`) mudam numa versão
  derivada (rotas e tabelas novas). São arquivos gerados: em conflito, descarta-se e gera-se de
  novo (`pnpm contracts:openapi`, `pnpm db:types`).
- **Extensão de borda é só dados.** `edge.ts` roda no runtime do middleware; por isso não
  importa nada de `modules/**`, e o núcleo é quem aplica as regras de host e CSP (404 por
  padrão). Uma extensão não afrouxa a CSP além de `https://<host>` explícito, sob o próprio
  prefixo.
- **Escrita em auditoria e em configuração remota passa por papéis-grupo.** O núcleo continua
  dono das políticas de `audit.events` e da função `app_config.set_setting`; a extensão só
  recebe o papel por `grant`. Cada `grant` novo precisa do próprio teste de grants.
- **`config.toml` é gerado**, então deixa de ser fonte de conflito de merge (ADR 0014).
- **Contratos por porta e lint de migration.** Toda porta substituível tem uma suíte de contrato
  (`platform/testing/contracts`) que o registro roda em teste; seção de exportação precisa do
  teste de isolamento com dois usuários; `pnpm db:lint-migrations` barra migration de extensão
  (`*_ext-<extensão>_*.sql`) que toque schema alheio. A CI da versão derivada roda os mesmos
  testes e o `pnpm supabase:config:check`.
- **Barreiras de merge (D21).** `pnpm db:lint-migrations` recusa, em migration `_ext-`, DDL,
  `GRANT`, `REVOKE` e `POLICY` sobre os schemas do núcleo (`identity`, `privacy`, `app_config`,
  `platform`, `audit`, `ops`, `auth`, `public`), exceto `grant <papel-grupo do núcleo> to
  <ext>_system`, `insert` em tabela declarada extensível (`app_config.operator_alert_exempt_keys`)
  e a FK 1:1 para `auth.users`. `pnpm vercel:check` limita o `vercel.json` às chaves de topo
  `$schema`, `functions`, `schedules`, `crons` e `regions`; `headers`, `rewrites`, `redirects` e
  `routes` são proibidos porque a borda é do middleware do núcleo. Os dois rodam no CI do núcleo e
  no da derivada.
- **Funções de extensão sobre `auth` (D22).** `auth_fn_owner` tem um conjunto fixo de grants em
  `auth` (users: `select`, `delete`, `update (banned_until, encrypted_password, raw_app_meta_data)`; sessions,
  refresh_tokens, identities: `select` e `delete`; audit_log_entries e flow_state: `delete`). Uma
  extensão cria no próprio schema uma função `SECURITY DEFINER` com `search_path = ''` e a
  transfere a `auth_fn_owner`; declara cada uma em `supabase/tests/auth-fn-registry.d/<ext>.json`
  (o pgTAP compara a lista real com núcleo mais `.d`); `execute` só para o `<ext>_system` dono do
  caso de uso. Papéis auxiliares começam por `<ext_schema>_`. São exceções fechadas do
  `db:lint-migrations`.
  O guard valida os registros JSON com schemas estritos, sem procurar nomes em
  strings arbitrárias de documentos. A serialização da onda 0 é:

  ```json
  { "functions": [{ "name": "grant_role", "signature": "()", "reason": "Conceder o papel de produto pela porta autorizada" }] }
  ```

  Esse documento fica em `supabase/tests/auth-fn-registry.d/<ext>.json`; `name`
  é o identificador local ao schema da extensão e `signature` contém a lista
  de argumentos PostgreSQL entre parênteses. Nome/assinatura são únicos.
  O registro de grupos em `expected-group-members.d/<ext>.json` é:

  ```json
  { "audit_writer": ["panel_admin_grantor"], "audit_operator_writer": [], "audit_reader": [], "app_config_writer": [] }
  ```

  O exemplo corresponde à extensão `panel`. Só os quatro grupos conhecidos
  são aceitos; cada membro começa pelo prefixo do schema declarado no nome
  do arquivo. O guard confere o par grupo/membro dos papéis auxiliares;
  a exceção já prevista para `<ext>_system` permanece. O pgTAP da onda 2
  confere todos os membros efetivamente existentes, inclusive system roles.
- **Manutenção por rota (D23).** `maintenance: 'exempt'` só com `auth.kind: 'webhook'` ou com
  política registrada como `{ operator: true }`; o teste estático lista as rotas isentas.
- **Fachada do app (D24).** `apps/mobile/src/extensions/api.ts` (`extensionAuth`,
  `withPreviousSession`, `useSessionSummary`, `extensionApiClient`, props de `SettingsItem`)
  substitui o acesso ao cliente do Supabase, que fica restrito a `features/auth` pelo
  dependency-cruiser. `withPreviousSession` é o único ponto em que código de extensão recebe um
  access token.
- **Escrita de configuração por painel.** `set_setting` tem controle otimista; a allowlist de
  chaves por papel é da aplicação de quem chama, e o núcleo só alerta (`ops.check_signals`) quando
  um operador mexe em chave fora de `operator_alert_exempt_keys` (risco residual R27).
- **Variáveis públicas de extensão** só passam com o prefixo certo e sem `SECRET`, `KEY_PRIVATE`
  ou `TOKEN` no nome.
- **Só uma extensão** pode registrar `captchaProvider` e só uma `captchaWidget`; duas fazem o
  boot e o teste falharem.
- Uma extensão com tabelas é coberta pelo teste de purga completa sem configuração, mas cada
  papel `*_system` novo precisa do próprio teste de grants.
- A licença MIT do base-app permite que alunos criem os próprios forks e extensões do mesmo
  jeito.
