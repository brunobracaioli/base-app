# Onda 0 — plano de execução e evidências

Data: 2026-11-24. Branch: `feat/w0-foundation`, criada da `main` após o merge
autorizado do PR #1 (`9917b1e`). Escopo: somente a fundação descrita em
[implementation-waves.md](implementation-waves.md#onda-0--fundação-do-monorepo).

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
cria implementações vazias que retornem sucesso para esses gates. A ausência
deles será registrada no relatório e impede afirmar a verificação completa
exigida pelo prompt desta sessão.

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

## Encerramento

Registrar aqui os comandos e resultados observados, conferir o diff e criar
commits Conventional Commits. Atualizar `NOTES.md` com o estado real. Não
marcar a onda como concluída enquanto houver requisito obrigatório pendente.
