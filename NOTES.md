# NOTES — base-app

## Status atual

- **Fase:** onda 0 integrada na `main` pelo
  [PR #2](https://github.com/brunobracaioli/base-app/pull/2), merge `cda886d`.
  O gate final em checkout limpo aprovou 18 gates, 128 testes e 6 versões de
  ferramentas no commit `6eea6e8`; a tree do merge é a mesma validada.
  Ondas 1/2/3 em implementação paralela autorizada, uma por sessão/worktree,
  com agentes Luna/xhigh. Nenhuma delas está concluída.
- **Próximo passo:** fechar as fundações como template de desenvolvimento,
  resolver as decisões de contrato/segurança abaixo e fechar
  os aceites pendentes e revisar cada onda antes
  de integrá-la em série. Ondas 4+ não iniciadas. GitHub Actions permanece
  desativado; a execução usa o ambiente local ou a KVM existente (ADR 0015).
- **Integração local em andamento:** `chore/template-foundation-integration`
  reúne os snapshots de W1/W2/W3 para verificação conjunta. A `main` permanece
  intacta. Aceites externos de lançamento viram checklists do derivado; isso
  não dispensa código funcional nem os testes reais de permissões do banco.
- **Plano/evidências:** [onda 0](docs/plan/wave-0-execution.md). Quatro frentes de
  implementação e uma revisão independente configuradas com Luna/xhigh; instalação
  e lockfile centralizados. Commit de decisões de spec: `07a74b5`.
- **Grupo atual:** [plano e matriz de aceite das ondas 1/2/3](docs/plan/waves-1-3-execution.md).
  Branches `feat/w1-api-platform`, `feat/w2-supabase-baseline` e
  `feat/w3-mobile-shell`; o gerente coordena contratos compartilhados e integração.
- **Verificação atual:** [relatório por critério](docs/plan/waves-1-3-verification.md).
  A integração local reúne W1 `54e202a`, W2 `2859af1` e o snapshot W3
  `96790e3`, além do guia de desenvolvimento e ADR 0016 proposto.
  Instalação congelada, 17 tarefas de lint/typecheck/test (296 testes aprovados,
  um teste condicionado à conexão real), arquitetura, formatação e build web
  passaram. Isso não inclui a fachada W3 ainda em edição nem substitui pgTAP.
  O checker TCP de W1 confirma o bloqueio pré-Proxy; a baseline W2 continua
  com 21 falhas em 152 asserções pgTAP e um erro do hook de Auth.
  KVM, volumes, rede, certificados temporários e túnel da verificação foram
  removidos; os demais workloads foram preservados.
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
  spike S-DB-1 comprovou TLS, claims por bind e limpeza após transação; o reset passou e a suíte pgTAP
  completa reprovou a baseline descrita abaixo. Nenhum projeto Supabase hospedado
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
- **Onda 2:** [ADR 0016](docs/adr/0016-template-supabase-compatibility.md)
  propõe funções de Auth pequenas pertencentes a `postgres`, helpers restritos
  para contagem/purga/auditoria, reserva atômica do teto de cadastro e alertas
  persistidos sem credenciais em `pg_net`. Consolidação da baseline experimental
  e alteração mínima do AGENTS.md também dependem de decisão explícita.
  Nenhuma dessas mudanças foi aplicada. O mapeamento de volume de e-mail
  continua no S-AU-4; a configuração hospedada será verificada no app derivado.
- **Bloqueio adicional da onda 2:** reset com sete migrations passou, mas
  pgTAP comprovou que `postgres` não consegue aplicar a baseline exigida em
  schemas gerenciados do Supabase. `auth_fn_owner` não recebe todos os grants
  de Auth; Storage e `pg_net` mantêm privilégios incompatíveis. ADR 0005
  registra a evidência e uma proposta de revisão, sem aprová-la. Não há ✅.
  O adaptador Kysely passou no pooler TLS real, incluindo auditoria atômica,
  rollback e microssegundos; tipos reais foram gerados sem drift.
- **Onda 3:** `withPreviousSession<T>` deve devolver o resultado seguro sem
  deixar escapar o token. Pendente decisão sobre restringir resultados a dados
  inspecionáveis e recusar valores opacos; a assinatura não foi trocada para
  `void`. Exports e prebuilds locais passaram. O código independente da fachada
  e três testes focados avançaram em W3; a árvore completa ainda reprova
  typecheck/test no método pendente. Builds EAS reais dependem de conta,
  projeto e assinatura do app derivado, conforme base-app §2.

- Visibilidade: o repositório fica privado até a v1; depois vira público, como template do
  GitHub (licença MIT).
- Spikes: S-TM-2 (onda 1), S-DB-1 e S-TM-4 (onda 2), S-TM-3 (onda 4), S-AU-1, S-AU-2, S-AU-3a,
  S-AU-3b e S-AU-4 (onda 6), S-BI-1 e S-TM-1 (onda 7), S-PR-1 (onda 9).
- Threat model: lacunas G1 a G36 e contradições C1 a C11 fechadas nas specs (ver
  `docs/security/threats/base-app.md` §7 e §8); resta implementar nas ondas.
