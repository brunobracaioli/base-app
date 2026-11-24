# ADR 0012 — CI/CD e release

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O método pede CI desde o dia 1 (lint, tipos, testes, build e scans de segurança), nada de
deploy sem pipeline verde, Actions pinadas por SHA e credenciais efêmeras. O template é
copiado por alunos: o que ele fizer por padrão vira o hábito deles, e a cadeia de release de um
app (build, assinatura, envio às lojas, OTA) é um alvo de ataque de cadeia de suprimentos.

## Decisão

### Integração contínua

- **GitHub Actions** (`.github/workflows/ci.yml`) em toda PR e na `main`: install com lockfile
  congelado, lint e format, typecheck, unit, dependency-cruiser, drift do OpenAPI, Supabase
  local com migrations, pgTAP, drift dos tipos Kysely, integração, gitleaks, Semgrep e
  osv-scanner.
- Actions **pinadas por commit SHA** (Dependabot atualiza), `permissions: contents: read` por
  padrão e o mínimo a mais por job.
- `.github/dependabot.yml` para npm e Actions. Branch protection na `main`: PR, CI verde e
  revisão.
- **Controles do GitHub como código (G2).** As proteções da plataforma (Environments com
  revisores, rulesets de `main` e de tags, secret scanning, relato privado de vulnerabilidade)
  não viajam com "Use this template". Por isso `.github/security-baseline.json` as descreve;
  `pnpm security:doctor` as confere por `gh api` (somente leitura) e roda como primeiro job
  (`protections`, `permissions: contents: read, actions: read`) de `db-migrate.yml`,
  `app-config-set.yml` e `release-ota.yml`, falhando se faltar revisor de Environment ou ruleset
  da `main` ou das tags; o que o `GITHUB_TOKEN` não enxerga fica na lista `manual` do baseline. O
  `pnpm bootstrap:init` mostra o plano, pede confirmação e aplica o baseline com `gh api` (login
  do operador; nenhum token é guardado). Um Environment citado em workflow e inexistente é criado
  sem proteção, então o baseline lista todos. Na onda 0 o implementador confirma o que a API
  entrega ao `GITHUB_TOKEN` e registra o resultado aqui. Também: `CODEOWNERS` para `.github/`,
  `supabase/migrations/`, `supabase/config.base.toml`, `packages/config/`,
  `apps/web/src/platform/auth/` e `docs/security/`; `zizmor` no CI (barra `pull_request_target`,
  injeção de expressão e `permissions` ausente); `SECURITY.md` com canal privado e relato privado
  de vulnerabilidade ligado.
- **Supply chain do pnpm:** pnpm 12.23.0, com `allowBuilds` explícito (allowlist dos
  pacotes que podem rodar scripts), `strictDepBuilds: true` e `minimumReleaseAge: 1440`
  em `pnpm-workspace.yaml`. Builds desconhecidos são bloqueados; versões publicadas
  há menos de 24 horas não são instaladas. `.npmrc` fica restrito a registro e
  autenticação, sem credenciais versionadas. O job de install não tem acesso a segredos.
  A atualização de `onlyBuiltDependencies`, removido no pnpm 11, foi aprovada pelo dono
  em 2026-11-24; mantém a allowlist e não autoriza exceções amplas.

### Visibilidade verificada na onda 0 (2026-11-24)

- A API consultada com o login do operador retornou zero Environments e 403
  para rulesets, informando restrição do plano para o repositório privado.
  Esse resultado é falha de proteção verificável, não aprovação manual.
- A [API de rulesets](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10)
  documenta que `bypass_actors` só é retornado a quem pode escrever no ruleset.
  O workflow com `contents: read` e `actions: read` não tem essa permissão.
  A ausência desse campo deve aparecer como verificação manual no baseline;
  quando o operador consegue lê-lo, o doctor deve validar seu conteúdo.
- A [API de Environments](https://docs.github.com/en/rest/deployments/environments?apiVersion=2026-03-10)
  permite leitura com Actions read e descreve regras e revisores na resposta.
  Ausência de Environment ou revisor obrigatório continua sendo falha.
- Não houve execução de Actions com `GITHUB_TOKEN`: a implementação permanece
  local, conforme a instrução de não fazer push. As conclusões de permissão
  acima são documentais; não substituem a futura execução no workflow.
- O plano necessário para rulesets pode diferir do necessário para revisores
  obrigatórios em Environments privados. Confirmar ambos antes de contratar
  um plano; tornar o repositório público é uma decisão separada do dono.

### API (Vercel)

- Git integration: preview por PR, produção na `main` com **Deployment Checks** exigindo o CI
  verde antes da promoção. Nenhum token da Vercel no GitHub.
- **Deployment Protection** nos previews, que só recebem segredos de staging.
- **Segredos por ambiente:** valores diferentes para Development, Preview e Production; os de
  produção marcados como Sensitive e disponíveis só em Production.

### Banco

- `db-migrate.yml`: ao mudar `supabase/migrations` na `main`, aplica em staging com
  `supabase db push --db-url`, espera aprovação no GitHub Environment `production` e aplica em
  produção.
- A conexão usa o papel **`migrator`**: só DDL nos schemas do app, nunca `postgres`. A URL fica
  em segredo do GitHub Environment, com rotação trimestral.
- `supabase config push` (aplica `config.toml`) usa `SUPABASE_ACCESS_TOKEN`, que vale para
  todos os projetos da conta; por isso fica numa conta de serviço que é membro só da org deste
  app, em Environment com aprovação.

### App (EAS)

- **EAS Workflows** (`apps/mobile/.eas/workflows/`) disparados por tag `mobile-v*`: build iOS e
  Android e submit para TestFlight e trilha interna.
- **Ruleset de tags** no GitHub: só quem tem permissão cria ou apaga `mobile-v*`.
- **Aprovação manual** no workflow de produção do EAS.
- **2FA obrigatório** na organização do Expo; **token de robô** com escopo mínimo para o CI.
- **OTA assinado, em dois jobs (G3):** `release-ota.yml` tem o job `build` (instala
  dependências, **sem segredo**, gera o bundle e o SHA-256) e o job `sign-and-publish`
  (Environment `release` com aprovação, **sem `pnpm install` e sem scripts de pacote**; confere o
  SHA-256 e que o commit é da `main`; instala só o `eas-cli` de `.github/release-tools/`, com
  lockfile próprio e `npm ci --ignore-scripts`; publica com `--skip-bundler`). A chave privada
  só existe no segundo job. O app só aceita atualização assinada com o certificado embutido.
  Perda ou rotação da chave: build novo com certificado novo e `minSupported` subido
  (mobile-app-shell.md §3.6). KMS com federação OIDC entra quando o EAS oferecer.
- Credenciais das lojas (chave da App Store Connect API, conta de serviço do Google Play)
  ficam no EAS, nunca no repositório.

### Exceções a credenciais efêmeras (OIDC)

Os serviços abaixo não oferecem federação OIDC para este uso hoje, então usam token estático
com escopo mínimo, em GitHub Environment com aprovação e rotação trimestral. Reavaliar quando
houver OIDC.

| Credencial | Onde fica | Situação em 2026-11 |
|------------|-----------|--------------------|
| URL do papel `migrator` (`db push`) | GitHub Environment | Sem OIDC do GitHub para o Postgres do Supabase |
| `SUPABASE_ACCESS_TOKEN` | GitHub Environment | Management API autenticada por token de conta |
| Token de robô do Expo | GitHub Environment | Sem OIDC do GitHub para o EAS |
| Chave privada de assinatura OTA | GitHub Environment `release`, só no job `sign-and-publish` | Sem KMS com OIDC no EAS |
| Chaves das lojas | EAS | Autenticação por chave de API |

Todo segredo tem dono, escopo e data de rotação registrados no how-to de rotação.

### Publicação do repositório (G14)

Antes de o repositório ficar público (Q3): varredura de segredos em **todo** o histórico
(`gitleaks detect --log-opts="--all"`) e revisão de referências internas, ou publicação com
histórico novo (o repositório de especificação tem poucos commits, então o histórico novo é o
padrão). Depois: `SECURITY.md`, relato privado de vulnerabilidade, GitHub Security Advisories,
tags anotadas e assinadas `v<major>.<minor>.<patch>` com release notes, orientação para os alunos
partirem de uma tag, 2FA obrigatório e proteção de branch para os mantenedores. Um aviso nas
releases acompanha toda correção de segurança, porque os apps derivados talvez nunca façam o
merge dela. Checklist em `docs/how-to/publish-repository.md`.

### Custo (G12)

Spend Management da Vercel com pausa no teto, regra de rate limit do Vercel Firewall em `/api`,
teto de gasto e alertas de 50%, 80% e 100% na Vercel, Upstash, Resend e Supabase
(base-app.md §3.13; how-to `cost-guardrails`).

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Deploy da Vercel por GitHub Actions com token | Coloca um token de produção no GitHub; a integração nativa dispensa |
| Build do app em CI próprio (macOS runner) | Mais caro e lento, e exigiria assinatura no GitHub; o EAS já guarda as credenciais |

## Consequências

- O CI precisa de Docker para o Supabase local. O job de banco é o mais lento e roda em
  paralelo com os demais.
- Os fluxos de release do app e da API são independentes; a compatibilidade vem da versão no
  path (`/v1`) e da atualização obrigatória (`app-config`).
- O token de robô do Expo e o `SUPABASE_ACCESS_TOKEN` são os segredos de maior alcance: o
  threat model os trata como alvo prioritário.
- Versões derivadas herdam estes workflows; os que forem acrescentados seguem as mesmas
  regras (SHA, `permissions`, Environment).
