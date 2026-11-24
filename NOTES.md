# NOTES — base-app

## Status atual

- **Fase:** onda 0 implementada e revisada localmente em 2026-11-24, na branch
  `feat/w0-foundation`: instalação congelada, 9 tarefas do Turbo, 119 testes,
  arquitetura, formatação e scanners locais passaram. O status permanece ⬜ pelas
  pendências de verificação abaixo. PR #1 mergeado na `main` (`9917b1e`).
- **Próximo passo:** revisar o relatório da onda 0, resolver as proteções do GitHub
  e validar o workflow real quando houver autorização de push. Não iniciar outra
  onda como se essas pendências estivessem concluídas. Nenhuma onda posterior iniciada.
- **Plano/evidências:** [onda 0](docs/plan/wave-0-execution.md). Quatro frentes de
  implementação e uma revisão independente configuradas com Luna/xhigh; instalação
  e lockfile centralizados. Commit de decisões de spec: `07a74b5`.
- **Versão derivada:** o app-bootstrap (pago, repositório privado) estende este núcleo pelos
  pontos de extensão de `docs/specs/base-app.md` §3.4. Mudança no núcleo pedida por ele é
  feita aqui primeiro, de forma genérica.

## Roadmap

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação do monorepo, tooling e CI | ⬜ |
| 1 | Plataforma da API | ⬜ |
| 2 | Baseline do Supabase | ⬜ |
| 3 | Casca do app mobile | ⬜ |
| 4 | Auth na API, perfil e consentimentos | ⬜ |
| 5 | Configuração remota e gates | ⬜ |
| 6 | Login por e-mail no app | ⬜ |
| 7 | Assinatura | ⬜ |
| 8 | Feature de exemplo | ⬜ |
| 9 | Exclusão de conta e site institucional | ⬜ |
| 10 | Exportação de dados | ⬜ |
| 11 | Tooling do template e documentação para alunos | ⬜ |
| 12 | E2E, release e lojas | ⬜ |

## Decisões pendentes

- Onda 0: a implementação local passou nos gates registrados, mas não foi
  enviada ao GitHub; a execução real de Actions e a leitura com `GITHUB_TOKEN`
  ainda não foram verificadas. O login do operador encontrou Environments ausentes
  e rulesets indisponíveis no plano privado atual (403).
- Configurar `production`, `production-config` e `release` com revisores,
  bloqueio de autorrevisão e branch `main`; rulesets de `main`, `mobile-v*` e `v*`.
  Confirmar um plano que comporte tanto rulesets quanto revisores em Environments
  privados; a sessão não alterou plano, visibilidade, configuração remota ou secrets.
- Docker Desktop sem integração com esta distribuição WSL. Os gates de banco da
  onda 2 requerem Docker; nenhum banco remoto foi criado ou alterado.
- `.env.example` só declara `SMTP_HOST` e `RESEND_SMTP_PASSWORD`, sem valores.
  As verificações locais da onda 0 não precisam deles. A configuração SMTP fica
  desativada no template; valores reais, porta, usuário, remetente, Mailpit e hook
  serão validados na onda 2. Não enviar credenciais no chat.

- Visibilidade: o repositório fica privado até a v1; depois vira público, como template do
  GitHub (licença MIT).
- Spikes: S-TM-2 (onda 1), S-DB-1 e S-TM-4 (onda 2), S-TM-3 (onda 4), S-AU-1, S-AU-2, S-AU-3a,
  S-AU-3b e S-AU-4 (onda 6), S-BI-1 e S-TM-1 (onda 7), S-PR-1 (onda 9).
- Threat model: lacunas G1 a G36 e contradições C1 a C11 fechadas nas specs (ver
  `docs/security/threats/base-app.md` §7 e §8); resta implementar nas ondas.
