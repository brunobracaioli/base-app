# NOTES — base-app

## Status atual

- **Fase:** ondas 0, 1, 2 e 3 concluídas localmente como fundação do template.
  As ondas 1/2/3 foram implementadas em paralelo com Luna/xhigh e integradas na
  branch `chore/template-foundation-integration`, worktree `/tmp/app-base-template`.
- **Próximo passo:** revisar/integrar esta branch na `main`; depois, onda 4 —
  Auth na API, perfil e consentimentos. Nenhuma onda 4+ foi iniciada. Login completo, assinatura, exclusão, exportação e bootstrap
  continuam nas ondas próprias; a v1 inteira do template ainda não está pronta.
- **Base:** `main` permanece em `cda886d`, merge da onda 0 pelo PR #2. Não houve
  novo push, PR, merge na `main`, deploy, publicação nem alteração de banco hospedado.
- **Verificação:** [matriz por critério](docs/plan/waves-1-3-verification.md).
  `pnpm ci:local`: 18 gates aprovados, 328 testes e um teste condicionado à
  conexão real. pgTAP: 11 arquivos/198 asserções aprovados. Build web e exports
  Android/iOS passaram; contratos, configuração e tipos sem drift.
- **Provas reais de banco:** migrations executadas como `postgres` sem
  superusuário; cadastro/SMTP local, reserva preservada após falha de envio,
  HTTP 429 com cota cheia e concorrência 300/301 e 20/21 validados. A prova TLS
  anterior continua válida para o adaptador executável idêntico por SHA-256;
  os tipos modificados foram regenerados e conferidos no banco real.
- **Limpeza:** containers, volumes, rede, diretório descartável e túnel SSH da
  verificação foram removidos, assim como as credenciais temporárias. Outros
  workloads da KVM foram preservados.
- **Uso local:** [desenvolver a partir do template](docs/how-to/develop-from-template.md).
  Gates usam ambiente local/KVM, sem GitHub Actions (ADR 0015).
- **Versão derivada:** estende o núcleo pelos pontos de base-app §3.4; mudanças
  no núcleo devem ser genéricas e manter o funcionamento com registros vazios.

## Roadmap

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação do monorepo, tooling e CI | ✅ |
| 1 | Plataforma da API | ✅ |
| 2 | Baseline do Supabase | ✅ |
| 3 | Casca do app mobile | ✅ |
| 4 | Auth na API, perfil e consentimentos | ⬜ |
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
