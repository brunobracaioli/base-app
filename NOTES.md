# NOTES — base-app

## Status atual

- **Fase:** onda 5 parcialmente entregue na branch `feat/w5-config-gates`,
  worktree `/tmp/app-base-w5`. API e mobile implementados e verificados;
  operação administrativa aguarda decisões de spec. A onda permanece ⬜.
- **Base:** `main` local integrou a onda 4 validada (`c690f28`). Nenhum push,
  PR, GitHub Actions, deploy ou alteração de banco hospedado.
- **Verificação:** código `fa3ef94` passou os 18 gates de `ci:local` em checkout
  limpo: 496 testes e um teste condicionado à conexão, lint, tipos, arquitetura,
  formato, drift de OpenAPI/config e scans. Build web e exports Hermes Android/iOS
  passaram. [Matriz de aceite](docs/plan/wave-5-verification.md).
- **Provas reais:** pgTAP 238 asserções/12 arquivos; oito tabelas sem drift de
  tipos; 24 checks no harness real e 24 checks HTTP com Next/Proxy e PostgreSQL
  TLS. Manutenção bloqueou em 30,674 s e foi revertida sem deploy.
- **Decisões pendentes:** leitores SQL restritos/force auditado, aprovação
  assinada por duas pessoas fora de Actions, limite temporal real do mobile,
  comparação SQL de versões e origem confiável do evento de rollback.
  [Propostas concretas](docs/plan/wave-5-execution.md). A aprovação não foi presumida.
- **Próximo passo:** concluir **a mesma onda 5**, após essas decisões: migration
  aditiva, adapters e comandos executáveis de set/rollback, aprovação e testes
  respectivos. Só depois iniciar a onda 6. O planejador puro já tem 19 testes;
  esses testes não certificam uma operação ainda não implementada.
- **Limpeza:** containers, volumes, rede, segredos/TLS e scratch da KVM, servidor
  Next local e túnel SSH removidos; outros workloads preservados. Outra prova
  real exige um fixture novo. Recibos em `.artifacts/w5-verification/` no
  checkout principal.
- **Histórico:** [onda 4](docs/plan/wave-4-verification.md) e
  [fundação 1–3](docs/plan/waves-1-3-verification.md) concluídas localmente.
  Contas, publicação e operação real dos derivados não são simuladas.

## Roadmap

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação do monorepo, tooling e CI | ✅ |
| 1 | Plataforma da API | ✅ |
| 2 | Baseline do Supabase | ✅ |
| 3 | Casca do app mobile | ✅ |
| 4 | Auth na API, perfil e consentimentos | ✅ |
| 5 | Configuração remota e gates | ⬜ |
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
