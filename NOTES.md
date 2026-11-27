# NOTES — base-app

## Status atual

- **Objetivo atual:** starter para alunos desenvolverem seus próprios produtos.
  A orientação do dono em 2026-11-27 substitui a execução automática das ondas
  restantes: preparar a documentação da base existente, sem novas funcionalidades.
- **Código de referência:** `cb6a2da` integra a implementação W6 de login por e-mail,
  sessão cifrada, perfil e consentimentos, sobre as ondas 0–5. O inventário está
  no [README](README.md); as specs também contêm funcionalidades futuras.
- **Verificação do código:** 624 testes aprovados e um condicionado não executado,
  separado; CI local 18/18 com checkout limpo em `cb6a2da`; pgTAP 294/14, build web,
  exports Android/iOS, arquitetura e tipos Kysely sem drift aprovados.
  [Evidências e limites W6](docs/plan/wave-6-verification.md).
- **Limite nativo:** APK debug x86_64 compilado e instalado no emulador, mas o
  fluxo Maestro não chegou ao login. A última tentativa terminou com timeout no
  Expo DevLauncher, sem a URL do projeto Metro. Nenhum fluxo nativo foi aprovado.
  O APK de laboratório não é uma entrega configurada para os alunos.
- **Ambiente do aluno (2026-11-27):** `pnpm dev` sobe Supabase local com Mailpit, Redis,
  API e Metro para o **Expo Go**, sem contas de backend (iPhone exige conta Expo grátis no Expo
  Go e no CLI) e com um backend por aluno
  ([spec](docs/specs/local-dev-stack.md), [tutorial](docs/tutorials/primeira-hora.md)).
  Validado nesta máquina (WSL 2 + Docker Desktop) pelo portão no IP do Wi-Fi:
  - OTP com o código lido no Mailpit;
  - JWT ES256;
  - `/api/v1/me` 200;
  - rotas administrativas 404;
  - bundles Android e iOS servidos pelo Metro.

  **Pendente:** abrir no Expo Go de um aparelho físico. O Supabase CLI fica em 2.122.1 porque
  o 3.4.0 não publicou a porta do banco no Docker Desktop.
- **Próxima tarefa padrão:** entender o produto do aluno, registrar suas decisões
  em `AGENTS.bootstrap.md` e escrever a spec da funcionalidade solicitada.
  Só retomar o roadmap do núcleo mediante pedido explícito de manutenção da base.
- **Operação:** contas, credenciais, endpoints HTTPS e builds de desenvolvimento
  pertencem ao projeto derivado. Não houve deploy nem alteração de banco hospedado.
  Código local, código publicado e serviços operacionais são estados distintos.

## Roadmap

| Onda | Entrega | Status |
|------|---------|--------|
| 0 | Fundação do monorepo, tooling e CI | ✅ |
| 1 | Plataforma da API | ✅ |
| 2 | Baseline do Supabase | ✅ |
| 3 | Casca do app mobile | ✅ |
| 4 | Auth na API, perfil e consentimentos | ✅ |
| 5 | Configuração remota e gates | ✅ |
| 6 | Login por e-mail no app | 🟡 Código verificado; QA nativa pendente |
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
  segredos pelo chat. S-TM-4 hospedado e EAS assinado não foram realizados; a validação completa
  dos fluxos em dispositivo permanece pendente. As evidências locais não são
  alegações de lançamento.
- **Governança:** os gates são locais e o código tem licença MIT. Rulesets,
  permissões e estado do GitHub devem ser conferidos na ação de publicação.
  Não inferir publicação, deploy ou validação em loja a partir de um CI verde.
