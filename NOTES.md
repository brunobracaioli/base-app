# NOTES — base-app

## Status atual

- **Fase:** onda 4 concluída localmente, na branch `feat/w4-auth-profile-consents`
  (`/tmp/app-base-w4`). Auth por JWKS, perfil e consentimentos estão implementados
  e verificados. A `main` local contém as fundações 0–3 (`4261bce`); sem push.
- **Próximo passo:** revisar/integrar a branch W4; depois executar a onda 5,
  configuração remota e gates. Nenhuma onda 5+ foi iniciada.
- **Evidências:** [verificação da onda 4](docs/plan/wave-4-verification.md) e
  [plano de execução](docs/plan/wave-4-execution.md). Código `f4fb085` aprovado
  em 18 gates locais, 405 testes e cobertura mínima por arquivo de domínio/aplicação.
  Um teste condicionado à conexão é separado da prova real.
- **Banco e Auth reais:** pgTAP passou em 238 asserções/12 arquivos; tipos de oito
  tabelas sem drift. O harness passou 22 verificações com JWT/JWKS reais, handlers,
  repositórios e PostgreSQL TLS. Rate limit/marcador/relógio foram fakes nas portas.
- **Contratos:** OpenAPI 1.1.0; GET/PATCH `/v1/me`, POST `/v1/me/consents` com 204,
  erros estáveis e limites fechados. `Me.createdAt` é a criação do perfil.
  `identity.read_fresh_roles` só retorna os papéis do próprio usuário.
- **Operação:** local/KVM existente, sem GitHub Actions, projeto hospedado,
  deploy, publicação, novo PR ou credenciais no chat. Login mobile completo,
  assinatura e demais funcionalidades permanecem nas ondas seguintes.
- **Limpeza:** stack, volumes, rede, chaves/credenciais temporárias e túnel da
  W4 removidos; workloads alheios da KVM preservados.
- **Uso local:** [desenvolver a partir do template](docs/how-to/develop-from-template.md).
  Fundamentos anteriores: [ondas 1–3](docs/plan/waves-1-3-verification.md).

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
