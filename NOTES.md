# NOTES — base-app

## Status atual

- **Fase:** onda 0 integrada na `main` pelo
  [PR #2](https://github.com/brunobracaioli/base-app/pull/2), merge `cda886d`.
  O gate final em checkout limpo aprovou 18 gates, 128 testes e 6 versões de
  ferramentas no commit `6eea6e8`; a tree do merge é a mesma validada.
  Ondas 1/2/3 em implementação paralela autorizada, uma por sessão/worktree,
  com agentes Luna/xhigh. Nenhuma delas está concluída.
- **Próximo passo:** concluir correções e gates independentes das ondas 1/2/3,
  resolver as decisões de contrato/segurança abaixo e revisar cada onda antes
  de integrá-la em série. Ondas 4+ não iniciadas. GitHub Actions permanece
  desativado; a execução usa o ambiente local ou a KVM existente (ADR 0015).
- **Plano/evidências:** [onda 0](docs/plan/wave-0-execution.md). Quatro frentes de
  implementação e uma revisão independente configuradas com Luna/xhigh; instalação
  e lockfile centralizados. Commit de decisões de spec: `07a74b5`.
- **Grupo atual:** [plano e matriz de aceite das ondas 1/2/3](docs/plan/waves-1-3-execution.md).
  Branches `feat/w1-api-platform`, `feat/w2-supabase-baseline` e
  `feat/w3-mobile-shell`; o gerente coordena contratos compartilhados e integração.
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
- Docker Desktop sem integração com esta distribuição WSL. A onda 2 usa Docker
  na KVM existente `ci-r3`, em namespace isolado e com portas em loopback. O
  spike S-DB-1 comprovou TLS, claims por bind e limpeza após transação; migrations
  e pgTAP completos ainda estão em execução. Nenhum projeto Supabase hospedado
  foi criado ou alterado.
- `.env.example` declara as variáveis sem valores. A onda 1 acrescenta host,
  banco/TLS, Redis, e-mail e observabilidade; os requisitos estão em
  [cost-guardrails](docs/how-to/cost-guardrails.md). SMTP/Mailpit e hook serão
  validados na onda 2. Não enviar credenciais no chat.

- **Onda 1:** Next 16.4.6 normaliza alguns caminhos antes do Proxy: barras
  repetidas e barra invertida geram 308 sem os headers configurados; segmentos
  `%2e`/`%2e%2e` perdem a forma original. ADR 0003 registra a prova HTTP.
  O dono precisa decidir entre ajustar o aceite ou exigir uma camada anterior
  ao Next. A exigência atual de 404/headers não foi relaxada.
- **Onda 2:** a purga de contas não confirmadas pertence a `auth_fn_owner`, mas
  a spec não lhe dá um caminho de escrita para o evento de contagem exigido.
  `set_setting` também precisa ler contagens de auditoria para o teto de 20
  alterações/hora, sem grant de leitura ao dono `app_config_admin`.
  Pendente decisão entre duas funções privadas de `ops`, restritas a essas
  operações, ou grants/políticas estreitos. A proposta detalhada está no plano
  do grupo. S-TM-4 também depende de projeto hospedado autorizado.
  Os sinais de contas não confirmadas (acesso por função de `auth_fn_owner`)
  e volume de e-mail (mapeamento de eventos do S-AU-4, hoje na onda 6) também
  permanecem sem aceite; não foi concedido acesso direto de `ops` a `auth`.
- **Onda 3:** `withPreviousSession<T>` deve devolver o resultado seguro sem
  deixar escapar o token. Pendente decisão sobre restringir resultados a dados
  inspecionáveis e recusar valores opacos; a assinatura não foi trocada para
  `void`. Exports e prebuilds locais passaram, mas os builds EAS reais de iOS e
  Android continuam pendentes de conta, projeto e configuração de assinatura.

- Visibilidade: o repositório fica privado até a v1; depois vira público, como template do
  GitHub (licença MIT).
- Spikes: S-TM-2 (onda 1), S-DB-1 e S-TM-4 (onda 2), S-TM-3 (onda 4), S-AU-1, S-AU-2, S-AU-3a,
  S-AU-3b e S-AU-4 (onda 6), S-BI-1 e S-TM-1 (onda 7), S-PR-1 (onda 9).
- Threat model: lacunas G1 a G36 e contradições C1 a C11 fechadas nas specs (ver
  `docs/security/threats/base-app.md` §7 e §8); resta implementar nas ondas.
