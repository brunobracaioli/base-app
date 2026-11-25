# NOTES — base-app

## Status atual

- **Fase:** onda 0 concluída e revisada localmente em 2026-11-24, na branch
  `feat/w0-foundation`. `pnpm ci:local` aprovou 18 gates, 128 testes e 6 versões
  de ferramentas em checkout limpo, com recibo atestável do commit `6750641`.
  [PR #2](https://github.com/brunobracaioli/base-app/pull/2) aberto. O dono substituiu
  Actions por execução local/KVM (ADR 0015). PR #1 mergeado na `main` (`9917b1e`).
- **Próximo passo:** revisar/integrar o PR #2 na `main`; depois, ondas 1/2/3 podem
  começar em worktrees distintas. Proteções de release e banco da onda 2 são
  gates separados. Nenhuma onda posterior iniciada.
- **Plano/evidências:** [onda 0](docs/plan/wave-0-execution.md). Quatro frentes de
  implementação e uma revisão independente configuradas com Luna/xhigh; instalação
  e lockfile centralizados. Commit de decisões de spec: `07a74b5`.
- **Versão derivada:** o app-bootstrap (pago, repositório privado) estende este núcleo pelos
  pontos de extensão de `docs/specs/base-app.md` §3.4. Mudança no núcleo pedida por ele é
  feita aqui primeiro, de forma genérica.

## Roadmap

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação do monorepo, tooling e CI | ✅ |
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

- GitHub Actions foi desativado na API (`enabled: false`) por instrução do dono.
  As tentativas anteriores, inclusive um `echo` isolado, terminaram em
  `BuildFailed`/`startup_failure` sem jobs. Não serão usadas como gate do projeto.
- Rulesets de `main`, `mobile-v*` e `v*` continuam sujeitos à disponibilidade
  do plano privado. Antes de release, revisar a governança de código e as
  aprovações operacionais; Environments de Actions não são requisito padrão
  após o ADR 0015. Plano, visibilidade e secrets não foram alterados.
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
