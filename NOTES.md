# NOTES — base-app

## Status atual

- **Fase:** onda 6 em implementação na branch `feat/w6-email-auth`, worktree
  persistente `.worktrees/w6`. Onda 5 integrada localmente à `main` em `6387bc3`.
  O dono autorizou a execução contínua das ondas restantes, com integração e
  verificação por onda; decisões anteriores preservadas no ADR 0017.
- **Entregue:** configuração pública/cache/gates; polling mobile foreground de 60 s;
  SQL restrito, CAS/force/auditoria; CLI com duas assinaturas e rollback validado.
- **Gates:** código `8777573` aprovado em 18/18 gates, checkout limpo, 533 testes
  e um teste condicionado separado. pgTAP 288/13; 38 checks CLI reais e 24 do
  harness API/banco. Build web, exports Android/iOS e drifts aprovados.
  [Matriz de aceite](docs/plan/wave-5-verification.md).
- **Próximo passo:** fechar as correções da revisão final de Auth, executar os
  gates integrados e consolidar W6 em commit local; depois, onda 7. O dono
  reiterou em 2026-11-27 a autorização para finalizar todas as ondas do template.
- **W6:** planos B dos spikes selecionados: cadastro por OTP antes da senha e
  OTP 10/300/10; migration e Auth/Mailpit verificados. Após as correções,
  189 testes mobile e 435 dos demais pacotes passaram; um teste condicionado
  permanece separado. Lint, tipos, arquitetura e formato aprovados; build web
  e tipos Kysely sem drift aprovados. pgTAP passou 294/14 após corrigir o isolamento de três
  testes que dependiam da ausência de histórico do cron; histórico preservado.
  Restauração offline de token expirado, reconexão/consentimentos, exposição
  do SDK na fachada e CTA de cadastro com método desligado foram corrigidos
  com regressões. Revisão final e gates do commit integrado pendentes.
  Emulador concluiu boot; Maestro e harness HTTPS preparados, fluxos nativos
  ainda sem resultado. [Verificação em andamento](docs/plan/wave-6-verification.md).
  W6 permanece ⬜ até concluir a verificação.
- **Recursos:** credenciais/planos/login do operador removidos. Stack descartável
  Auth/Postgres/Mailpit da KVM permanece sob controle do gerente para W6;
  será limpa ao fim da execução contínua. Outros workloads preservados.
- **Operação:** sem push, PR, GitHub Actions, deploy ou banco hospedado alterado.
  Evidências em `.artifacts/w5-completion/` no checkout principal.
  Handoffs e provas parciais W6 em `.artifacts/recovery/w6/` no mesmo checkout.
  Um reinício apagou `/tmp`; ferramentas e worktrees foram recuperadas em
  diretórios persistentes. Não reutilizar os caminhos temporários antigos.

## Roadmap

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação do monorepo, tooling e CI | ✅ |
| 1 | Plataforma da API | ✅ |
| 2 | Baseline do Supabase | ✅ |
| 3 | Casca do app mobile | ✅ |
| 4 | Auth na API, perfil e consentimentos | ✅ |
| 5 | Configuração remota e gates | ✅ |
| 6 | Login por e-mail no app | ⬜ |
| 7 | Assinatura | ⬜ |
| 8 | Feature de exemplo | ⬜ |
| 9 | Exclusão de conta e site institucional | ⬜ |
| 10 | Exportação de dados | ⬜ |
| 11 | Tooling do template e documentação para alunos | ⬜ |
| 12 | E2E, release e lojas | ⬜ |

## Decisões aprovadas e limites

- **Template:** base-app §2 separa aceites de código/provas locais da configuração
  operacional do derivado. Contas, EAS, assinatura, lojas e deploy não são simulados.
- **HTTP:** Next pode normalizar paths ou responder 308 antes do Proxy sem headers
  do app. O checker TCP exige Location seguro e testa isolamento no destino final
  (ADR 0003); respostas controladas pelo app mantêm os headers.
- **Banco:** ADR 0016 aprovado. Funções Auth restritas pertencem a `postgres` e
  ficam no registro fechado do núcleo. Extensões não podem criar outras. A
  baseline experimental foi consolidada com autorização; não é uma migration
  de atualização para bancos que já aplicaram os arquivos antigos.
- **Cotas/alertas:** reservas de cadastro são atômicas e podem ser consumidas por
  falha posterior. Alertas são persistidos em `ops.alerts`, sem `pg_net` ou
  credencial de envio no banco. Monitoramento externo e mapeamento de volume de
  e-mail (S-AU-4) continuam nos passos próprios do derivado/onda 6.
- **Mobile:** `withPreviousSession` aceita somente resultados inspecionáveis,
  recusa conteúdo com o token e limpa o cliente secundário sem encerrar a nova
  sessão primária. Extensões são código confiável, sem garantia de sandbox.
- **Operação futura:** valores continuam vazios nos `.env.example`. As contas e
  variáveis do derivado estão documentadas no guia e na referência. Não enviar
  segredos pelo chat. S-TM-4 hospedado, EAS assinado e testes em dispositivo não
  foram realizados; as evidências locais não são alegações de lançamento.
- **Governança:** Actions está desativado. Rulesets e permissões de release devem
  ser conferidos quando houver publicação. O repositório continua privado até
  a v1; a intenção permanece publicá-lo como template MIT.
