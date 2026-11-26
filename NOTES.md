# NOTES — base-app

## Status atual

- **Fase:** onda 5 ✅ concluída como código do template, branch `feat/w5-config-gates`
  (`/tmp/app-base-w5`). O dono aprovou todas as pendências e a execução contínua
  das ondas restantes; decisões em ADR 0017.
- **Entregue:** configuração pública/cache/gates; polling mobile foreground de 60 s;
  SQL restrito, CAS/force/auditoria; CLI com duas assinaturas e rollback validado.
- **Gates:** código `8777573` aprovado em 18/18 gates, checkout limpo, 533 testes
  e um teste condicionado separado. pgTAP 288/13; 38 checks CLI reais e 24 do
  harness API/banco. Build web, exports Android/iOS e drifts aprovados.
  [Matriz de aceite](docs/plan/wave-5-verification.md).
- **Próximo passo:** integrar W5 localmente e executar onda 6: spikes de Auth e
  Mailpit antes de modelo/adaptadores/UI. Continuar as ondas até completar o
  código do template; contas, publicação e dispositivos não serão simulados.
- **Recursos:** credenciais/planos/login do operador removidos. Stack descartável
  Auth/Postgres/Mailpit da KVM permanece sob controle do gerente para W6;
  será limpa ao fim da execução contínua. Outros workloads preservados.
- **Operação:** sem push, PR, GitHub Actions, deploy ou banco hospedado alterado.
  Evidências em `.artifacts/w5-completion/` no checkout principal.

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
