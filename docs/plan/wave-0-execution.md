# Onda 0 — plano de execução e evidências

Data: 2026-11-24. Branch: `feat/w0-foundation`, criada da `main` após o merge
autorizado do PR #1 (`9917b1e`). Escopo: somente a fundação descrita em
[implementation-waves.md](implementation-waves.md#onda-0--fundação-do-monorepo).

**Executor vigente:** local/KVM, por instrução explícita do dono depois da
abertura do PR #2. GitHub Actions está desativado no repositório. ADR 0015 e
`docs/specs/local-quality-gates.md` substituem o executor inicial; os gates
locais e os controles de release continuam separados.

## Paralelismo do roadmap

- Depois de 0: 1, 2 e 3 podem avançar em worktrees separadas.
- Depois de 1 e 2: 4 pode avançar enquanto 3 termina. 5 espera ambas.
- Depois de 7: 8 e 9 podem avançar em paralelo. 10 depende de 9 e pode
  acompanhar uma 8 ainda em andamento; 11 espera 8 e 10.
- 5 → 6 → 7 e 11 → 12 são sequenciais.

Essas são independências do grafo, não autorização para editar arquivos comuns
simultaneamente. Contratos, lockfile, migrations e configuração compartilhada têm
integração serializada. Nesta sessão os agentes trabalham em partes da onda 0.

## Responsabilidade pelos arquivos

| Frente Luna/xhigh | Arquivos exclusivos | Evidência de aceite |
| --- | --- | --- |
| Workspace e regras | Manifests raiz, lockfile, configurações TS/ESLint/Prettier; `packages/tooling/src/{lint,architecture}/` | Instalação congelada; lint, tipos, testes e fixtures de violações arquiteturais |
| Configuração e contratos | `packages/{config,contracts}/`, `docs/reference/openapi.yaml` | Zod rejeita produto inválido; extensões vazias funcionam; contrato health; geração determinística |
| Guards | `packages/tooling/src/guards/`, `supabase/config*` | Mescla TOML, marcadores, invariantes e CAPTCHA; parser SQL aceita só exceções previstas; allowlist Vercel |
| CI e proteções | `.github/`, `.semgrep/`, hook, `SECURITY.md`, `packages/tooling/src/security/` | Fixtures de proteções ausentes; workflow inseguro rejeitado; scanners e SHAs |
| Gerente | Plano, specs/ADRs quando autorizado, revisão e relatório | Critérios conferidos individualmente; commits locais; nenhuma publicação da implementação |

O responsável pelo workspace consolida dependências e executa a instalação;
os demais não escrevem o lockfile. Testes acompanham cada implementação.

## Matriz de verificação

1. `pnpm install --frozen-lockfile` e `pnpm turbo run lint typecheck test`:
   pacotes instaláveis e verificáveis com o lockfile versionado.
2. `security:doctor`: fixtures com Environment sem revisores, ruleset da
   `main` ausente e ruleset de tags ausente devem falhar. Falhas de acesso às
   proteções obrigatórias não constituem evidência de proteção.
3. `zizmor`: fixture com `pull_request_target` deve falhar.
4. `db:lint-migrations`: negar tabela/policy/grant/trigger nos schemas do
   núcleo; aceitar apenas grants e transferência de função explicitamente
   previstos, com registros e prefixos corretos.
5. `vercel:check`: negar headers, rewrites, redirects e routes; aceitar
   functions, crons, schedules e regions.
6. `supabase:config:check`: testar mescla, ordem, cabeçalho, drift,
   sobrescrita protegida com/sem marcador e matriz anônimo/linking × CAPTCHA.
7. Dependency-cruiser: exemplos permitidos e proibidos de cada fronteira de
   §3.5, inclusive `supabase-client-only-in-auth`.
8. OpenAPI: gerar duas vezes e comparar; depois executar o comando de drift
   contra o YAML versionado.
9. Configuração: exemplos não operacionais e limites válidos passam; valores
   inválidos produzem erro Zod.
10. CI: gitleaks, Semgrep, osv-scanner e zizmor presentes; Actions com SHA,
    permissões mínimas; schemas de body estritos, `.strip()` só em webhooks.

pgTAP e drift dos tipos Kysely dependem dos artefatos da onda 2. A onda 0 não
cria implementações vazias que retornem sucesso para esses gates. Eles permanecem
explicitamente fora da verificação da fundação e serão exigidos na onda correspondente.

## Decisões aprovadas e limitações

- O npm informa pnpm 12.23.0, que removeu `onlyBuiltDependencies` e transferiu
  configurações para `pnpm-workspace.yaml`. Aprovado pelo dono: `allowBuilds`
  explícito, builds desconhecidos bloqueados e idade mínima de 1.440 minutos.
- TypeScript 7.0.2 excede o peer range `<6.1.0` do typescript-eslint 8.74.0.
  A versão estável compatível identificada é 6.0.3. Node 24.22.3 atende aos
  engines das ferramentas escolhidas.
- O contrato health não define seus números de rate limit nem a política em
  falha do Redis. Aprovado pelo dono: 60/min por IP, `onStoreFailure: open`.
- JSON/JSONC do Supabase pode ter precedência sobre TOML. Aprovado pelo dono:
  rejeitar arquivos concorrentes para garantir que o guard valide a
  configuração efetivamente usada.
- O dono aprovou `env(SMTP_HOST)` em lugar do host SMTP fixo, preservando
  `env(RESEND_SMTP_PASSWORD)`. Host, porta, usuário, remetente e a entrega local
  exclusiva ao Mailpit continuam sujeitos ao S-TM-4 da onda 2; não se presume
  um hostname de container nem uma conta Resend configurada.
- Exemplos de URLs com `<ref-prod>`/`<ref-staging>` não são URLs válidas.
  O exemplo usará domínios reservados `.invalid`, explicitamente sem serviço,
  preservando os demais valores de exemplo já fornecidos na spec.
- A consulta autenticada ao GitHub encontrou zero Environments e retornou
  403 para rulesets no repositório privado, com indicação de limitação do
  plano. O token do operador não comprova a visibilidade do `GITHUB_TOKEN`
  de Actions. A implementação não altera plano, visibilidade ou proteções.
- O workloop está vinculado ao gerente. O registro dos subagentes nativos
  rejeitou os identificadores expostos por `collaboration` por exigir UUIDs
  indisponíveis. A unidade coordenada do gerente cobre as edições; cada
  agente mantém handoff exclusivo, sem fabricar identificadores de runtime.
- `docker version` falhou: Docker Desktop sem integração com esta distribuição
  WSL. Não foi possível validar um servidor Docker local. Não houve alteração
  de configuração do Docker nem criação de banco remoto.

Fontes de compatibilidade consultadas: [pnpm 11 — mudanças de configuração](https://pnpm.io/blog/releases/11.0),
[política de scripts do pnpm](https://pnpm.io/settings/build),
[JSON Schema nativo do Zod](https://zod.dev/json-schema) e
[changelog do Supabase](https://supabase.com/changelog.md).

## Resultado local e critérios de aceite

Verificação final em 2026-11-24, Node 24.22.3 e pnpm 12.23.0. Comandos
executados pelo gerente no checkout integrado, após a revisão e as correções:

| Comando/gate | Resultado observado |
| --- | --- |
| `pnpm install --frozen-lockfile` | Exit 0; 243 entradas verificadas contra a política de supply chain, sem exceção à idade mínima |
| `pnpm turbo run lint typecheck test` | Exit 0; 9/9 tarefas; 119 testes em 9 arquivos (config 7, contratos 7, tooling 105) |
| `pnpm architecture:check` | Exit 0; 56 módulos e 126 dependências; nenhuma rota real de API ainda |
| `pnpm format:check` | Exit 0 |
| `pnpm contracts:openapi` | Exit 0; OpenAPI gerado da mesma fonte Zod |
| `git diff --exit-code -- docs/reference/openapi.yaml` após regenerar | Exit 0; comparação contra o arquivo já adicionado ao índice, não contra um arquivo untracked |
| `pnpm supabase:config` e `pnpm supabase:config:check` | Exit 0; TOML gerado e atualizado |
| `git diff --exit-code -- supabase/config.toml` após regenerar | Exit 0; comparação contra o TOML já adicionado ao índice |
| `pnpm db:lint-migrations` | Exit 0; zero migrations reais nesta onda; políticas exercitadas pelas fixtures |
| `pnpm vercel:check` | Exit 0; `vercel.json` ainda ausente, explicitamente informado pelo comando |
| Semgrep 1.186.0: testes das regras TS/SQL | Exit 0; 6/6 e 2/2 regras com testes aprovados |
| Semgrep: scan de `packages` e `supabase` | Exit 0; 37 arquivos analisados, zero achados |
| zizmor 1.33.1: `.github/` | Exit 0; nenhum achado reportado no perfil padrão |
| zizmor: fixture `pull_request_target` | Exit 14 esperado; trigger perigoso e injeção de expressão detectados |
| Gitleaks 8.30.1: working tree | Exit 0; nenhum vazamento |
| OSV-Scanner 2.7.1 | Exit 0; 260 pacotes no lockfile, nenhum problema encontrado |
| Pins de Actions/imagens | 4 commits conferidos no GitHub e 3 digests conferidos nos registries; nenhum `uses` pinado por tag |
| `pnpm security:doctor --repo brunobracaioli/base-app` | Exit 1 esperado para o estado remoto atual: 3 Environments ausentes e rulesets indisponíveis (403); 2 itens manuais |

O Semgrep precisou de cache de versão em `/tmp` porque o home está somente
leitura no sandbox. Isso não desativou regra nem suprimiu achado. O pnpm usou
store dentro de `node_modules` porque o store global não aceitava hard links.

| Critério da onda 0 | Teste/evidência |
| --- | --- |
| Instalação congelada, lint, tipos e testes | Gate integrado acima, exit 0 |
| Doctor rejeita proteção ausente; zizmor rejeita workflow inseguro | `packages/tooling/src/security/security-doctor.test.ts` (18 testes) e fixture `fixtures/zizmor/pull-request-target.yml` |
| Migrations de extensão e exceções limitadas | `packages/tooling/src/guards/db-lint-migrations.test.ts` (24 testes), incluindo roles, FK 1:1, registros estritos e delta contra upstream |
| Allowlist Vercel | `packages/tooling/src/guards/vercel-config.test.ts` (9 testes) |
| Anônimo/manual linking só com marcador e CAPTCHA | `packages/tooling/src/guards/supabase-config.test.ts` (11 testes) |
| Cliente Supabase restrito ao auth | `packages/tooling/src/architecture/dependency-cruiser.test.ts` (18 testes), incluindo pacote resolvido |
| Sobrescrita protegida, ordem, drift e arquivos JSON concorrentes | Mesma suíte de Supabase; geração/check do arquivo real |
| Contrato e geração OpenAPI | `packages/contracts/src/contracts.test.ts` (7 testes), com extensões e colisões |
| Produto inválido falha com Zod | `packages/config/src/product.schema.test.ts` (7 testes) |
| Scanners e Actions pinadas | Workflow versionado, scans locais e conferência independente dos SHAs/digests |
| `.strict()`/`strictObject`, `.strip()` só em webhooks | `packages/tooling/src/lint/rules.test.ts` (21 testes), também cobrindo importação indireta, paths falsos e JWT |

Há ainda quatro testes de proveniência de handlers em
`packages/tooling/src/architecture/routes-use-define-route.test.ts`. São provas
estáticas com fixtures; a implementação de `defineRoute` e a rota health são
da onda 1.

## Limites, ação humana e próxima onda

- Depois do relatório local, o dono autorizou push e PR. O código está no
  [PR #2](https://github.com/brunobracaioli/base-app/pull/2). Actions apresentou
  `startup_failure` antes dos jobs, inclusive no diagnóstico isolado de um
  único `echo` (run 45511970833). O dono determinou execução local/KVM; a
  conclusão da onda passa a exigir o recibo de `pnpm ci:local`, não Actions.
- pgTAP, `supabase start`, migrations aplicadas e drift Kysely não foram
  executados: os artefatos são da onda 2 e o Docker desta distribuição está
  indisponível. O guard TOML não prova boot do Auth, entrega SMTP ou config push.
- Nenhum spike formal está previsto na onda 0. As escolhas de compatibilidade
  e as decisões aprovadas estão nas specs/ADRs; S-DB-1 e S-TM-4 continuam para
  a onda 2. O parser SQL está alinhado ao PostgreSQL 17; corpos PL/pgSQL não
  constituem prova de autorização pelo parser e continuam sujeitos à revisão
  e aos testes de catálogo/permissões da onda 2.
- A governança de código (rulesets/revisão) e as aprovações de operações remotas
  continuam como gates de release. O baseline local não exige Environments de
  Actions, e nenhuma contratação de plano ou publicação do repositório foi feita.
- Não há segredo necessário para os testes locais. Para a etapa SMTP, preencher
  `SMTP_HOST` e `RESEND_SMTP_PASSWORD` em `.env.local`/secret manager conforme o
  ambiente, sem compartilhar valores no chat. O template mantém SMTP customizado
  desativado até essa configuração e validação.
- Depois do fechamento da onda 0, o próximo grupo é 1/2/3, em worktrees distintas,
  com contratos compartilhados fixados e integração de uma branch por vez.
