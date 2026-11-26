# Execução contínua do template — 2026-11-26

O dono pediu implementar todas as pendências numa execução contínua. As quatro
propostas da onda 5 foram aprovadas (ADR 0017). Preservam-se commits/branches
por onda, contratos antes de handlers, testes e a distinção entre código do
template e contas/publicação do derivado. Não haverá push, PR ou deploy.

## Sequência e paralelismo

- Encerrar W5: SQL e CLI assinados, prova real, CI e documentação.
- Os spikes Auth de W6 podem ser preparados em checkout isolada enquanto a
  prova administrativa de W5 termina: consomem a baseline Auth e os contratos
  API/mobile já verificados, não o CLI pendente. A integração/aceite de W6 só
  ocorre depois de W5. Operações na KVM são coordenadas por um único gerente.
- W6: spikes primeiro; depois contrato interno/modelo, adaptadores e UI em
  arquivos disjuntos. Fluxos reais locais com Mailpit e provas determinísticas.
- W7: contratos/REST/cache e SDK/UI depois de Auth. Medições que exigem conta
  não serão inventadas; ficam identificadas separadamente das provas locais.
- W8 e W9 podem ser desenvolvidas em paralelo após W7, com contratos e merges
  serializados. W10 depende da infraestrutura de privacidade de W9.
- W11: bootstrap e documentação do template completo. W12: automação de E2E e
  release local, checklists de ativação e evidências disponíveis no ambiente.

## Plano da primeira etapa W6

Criar `supabase/tools/w6-auth-spikes.mjs` e registrar resultados em
`identity-and-auth.md` §8/ADR 0004. Testar templates por locale, pré-sequestro,
troca de e-mail, senha/nonce e limites OTP na stack descartável local. Escolher
os padrões B já definidos quando A não estiver comprovado. Nenhum segredo,
e-mail, código ou token vai a logs, fixtures versionadas ou recibos.

Depois dos spikes: modelo/portas em `features/auth/model`, adaptadores em
`features/auth/adapters`, UI/rotas e i18n em seus diretórios; fakes nas portas e
provas reais separadas. Chaves, contas, DNS e dispositivos reais continuam
configuração do derivado; nenhum gate indisponível será declarado executado.
