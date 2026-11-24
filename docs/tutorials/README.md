# Tutoriais

Aprendizado guiado, na ordem. Cada tutorial parte do resultado do anterior e termina com algo
que funciona. O conteúdo de cada um é escrito na onda de implementação correspondente
([plano de ondas](../plan/implementation-waves.md)).

| # | Tutorial | Resultado |
|---|----------|-----------|
| 1 | Preparar o ambiente | Node, pnpm, Docker, Supabase CLI e EAS CLI instalados; repositório criado do template; `pnpm install` e `pnpm turbo run lint typecheck test` verdes |
| 2 | Rodar local com Supabase e Mailpit | `supabase start` e `pnpm --filter web dev` rodando; `GET /v1/health` responde `ok`; a caixa do Mailpit recebe e-mails de teste |
| 3 | Primeiro login | Build de desenvolvimento no simulador ou aparelho; conta criada pelo código de e-mail (lido no Mailpit) e login por senha funcionando |
| 4 | Configurar o RevenueCat e comprar em sandbox | Projeto, produtos, entitlement e oferta no RevenueCat; paywall remoto no app; compra de teste que libera a ação de exemplo no servidor em segundos |
| 5 | Publicar API e banco (Vercel e Supabase) | Projetos de staging e produção no Supabase com `config.toml` e migrations aplicadas; API e site no ar na Vercel, com segredos por ambiente |
| 6 | Primeiro build e envio às lojas | Build de produção pelo EAS e envio ao TestFlight e à trilha interna do Google Play |
| 7 | Criar sua primeira feature como fatia vertical | Uma feature nova (contrato, tabela com RLS, caso de uso, rota e tela) com testes, seguindo a feature de exemplo |
| 8 | Como estender com um módulo | Uma extensão registrada em `extensions/index.ts` com rota, handler de purga e tabela própria, sem editar o núcleo |

## Pré-requisitos gerais

- Conta no GitHub, Supabase, Vercel, Expo, RevenueCat e Resend. Apple Developer e Google Play
  Console só são necessários a partir do tutorial 6.
- Conhecimento básico de TypeScript e de linha de comando.

## Depois dos tutoriais

- Tarefas específicas: [how-to/](../how-to/README.md).
- Por que o template é assim: [explanation/](../explanation/why-this-architecture.md).
