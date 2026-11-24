# NOTES — base-app

## Status atual

- **Fase:** especificação concluída em 2026-11-24 (spec principal, specs de área, 14 ADRs,
  threat model, plano de ondas). Nenhum código ainda.
- **Próximo passo:** revisão da spec pelo dono; depois, onda 0 com um agente de código
  (prompt padrão em `docs/plan/implementation-waves.md`).
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

- Visibilidade: o repositório fica privado até a v1; depois vira público, como template do
  GitHub (licença MIT).
- Spikes: S-TM-2 (onda 1), S-DB-1 e S-TM-4 (onda 2), S-TM-3 (onda 4), S-AU-1, S-AU-2, S-AU-3a,
  S-AU-3b e S-AU-4 (onda 6), S-BI-1 e S-TM-1 (onda 7), S-PR-1 (onda 9).
- Threat model: lacunas G1 a G36 e contradições C1 a C11 fechadas nas specs (ver
  `docs/security/threats/base-app.md` §7 e §8); resta implementar nas ondas.
