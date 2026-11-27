# base-app

**Uma base de código para alunos começarem seus próprios apps mobile com Claude Code,
Codex ou outro agente de programação.** O aluno parte da estrutura existente, descreve
seu produto e desenvolve as funcionalidades que sua ideia precisa.

O repositório é um starter de desenvolvimento, com licença MIT. Ele não é um produto
comercial configurado nem exige que o aluno termine o roadmap interno do template antes
de começar. As integrações usam contas e configurações do próprio projeto derivado.

## O que já vem implementado

| Área                    | O que está no código                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estrutura               | Monorepo com pnpm e Turborepo; TypeScript strict; organização por funcionalidades e contextos, com regras de dependência verificadas                                              |
| App mobile              | React Native + Expo Router, navegação protegida, tema claro/escuro/sistema, português/inglês/espanhol, cliente tipado da API e pontos de extensão                                 |
| Login por e-mail        | Telas, modelo e adaptadores para código por e-mail, cadastro com confirmação antes de definir senha, login com senha, recuperação, reautenticação, troca de senha/e-mail e logout |
| Sessão                  | Armazenamento cifrado no aparelho, restauração e renovação da sessão, tratamento de falha temporária de rede e proteção contra respostas de uma sessão anterior                   |
| API                     | Next.js, verificação de JWT por JWKS, validação de entradas, erros padronizados, headers de segurança e políticas de rate limit                                                   |
| Perfil e consentimentos | Leitura/edição de perfil e registro de aceite das versões de termos e privacidade                                                                                                 |
| Banco                   | Migrations Supabase/Postgres, RLS, papéis restritos, auditoria, rotinas de manutenção e testes de banco                                                                           |
| Configuração remota     | Configuração pública, cache e gates de manutenção e atualização obrigatória no app e na API                                                                                       |
| Qualidade               | Testes, lint, typecheck, verificações de arquitetura, geração de contratos OpenAPI e gates locais de segurança                                                                    |

**Implementado não significa configurado ou validado em produção.** O login exige um
Supabase Auth e uma API configurados; as rotas protegidas também precisam das integrações
do servidor. Os exemplos de variáveis ficam vazios e nenhuma conta externa é criada pelo
template. Sem configuração, o Auth retorna indisponibilidade; não há login simulado.

A revisão de código `cb6a2da` passou em 624 testes e 18 gates locais; um teste
condicionado não executado é registrado separadamente. O banco teve 294 asserções aprovadas. Build web e exports Android/iOS também passaram. A validação
completa dos fluxos mobile em aparelho/emulador **continua pendente**. Compilação e testes
de código não são apresentados como aprovação nas lojas. Consulte [NOTES.md](NOTES.md)
e a [verificação da autenticação](docs/plan/wave-6-verification.md).

## O que ainda não está incluído como funcionalidade pronta

- Compra, paywall, restauração e gerenciamento de assinatura pelo RevenueCat.
- Ação de exemplo protegida por assinatura.
- Exclusão de conta completa no app e pela web e exportação de dados.
- Site institucional e documentos legais finais do produto do aluno.
- Comando `pnpm bootstrap:init`, automação completa de release e publicação nas lojas.

Existem specs, contratos de extensão ou telas reservadas para parte dessas evoluções.
Isso não equivale à implementação completa. Adicione essas funcionalidades quando forem
necessárias ao produto, sem assumir que tudo descrito nas specs já foi entregue.

## Começar a partir da base

Crie uma cópia ou fork do repositório para o seu produto. Na pasta da cópia, use as
versões fixadas em `.nvmrc` e `package.json`:

```bash
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

Para abrir a página inicial da API/site local:

```bash
pnpm --filter web dev
```

Ela fica em `http://localhost:3000` e não exige contas externas para mostrar a página
básica. Essa página não é uma versão web do app mobile nem prova de login funcionando.

Para iniciar o servidor do app mobile:

```bash
pnpm --filter mobile start
```

O app usa **development client**, não Expo Go. É necessário ter um build de
desenvolvimento instalado no aparelho/emulador e abrir o projeto servido pelo Metro.
Iniciar o servidor, sozinho, não instala nem abre o app. O guia explica os comandos
de build local e a configuração das integrações:
[desenvolver a partir do template](docs/how-to/develop-from-template.md).

Personalize nome, identificadores, scheme, idiomas e métodos de login em
[`packages/config/src/product.config.ts`](packages/config/src/product.config.ts).
Os nomes, IDs e origens de exemplo desse arquivo não são uma configuração operacional.

## Trabalhar com Claude Code ou Codex

O Claude Code encontra as orientações em [CLAUDE.md](CLAUDE.md), que referencia
[AGENTS.md](AGENTS.md). Outros agentes podem ler o mesmo `AGENTS.md`.

Ao começar um produto derivado, o agente deve:

1. Conferir o código desta revisão e explicar o que existe, o que precisa ser configurado
   e o que falta implementar.
2. Entender a ideia e o primeiro fluxo útil do aluno; criar uma spec curta antes do código.
3. Registrar as decisões do produto em `AGENTS.bootstrap.md` e em seus próprios documentos
   de spec/plano, preservando a arquitetura e a segurança da base.
4. Implementar a funcionalidade solicitada. O roadmap do núcleo só deve ser executado
   quando houver um pedido explícito para manter ou evoluir o próprio template.

Um prompt inicial possível:

> Este repositório é a base do meu produto: [descreva a ideia]. Leia README.md, CLAUDE.md
> e AGENTS.md. Confira o que já está implementado nesta revisão e explique quais integrações
> precisarei configurar. Trate esta cópia como um produto derivado, registre suas instruções
> em AGENTS.bootstrap.md e proponha uma spec curta para o primeiro fluxo útil. Preserve a
> arquitetura e os controles existentes. Desenvolva o meu produto; não continue automaticamente
> as ondas internas do template.

Há um [modelo de instruções para o derivado](docs/reference/AGENTS.bootstrap.example.md).
Preencha-o com as decisões reais do produto; não invente contas, credenciais, preços ou URLs.

## Verificar mudanças

```bash
pnpm turbo run lint typecheck test
pnpm architecture:check
pnpm --filter web build
```

Para a bateria integral com scanners e recibo por revisão, siga o
[guia do gate local/KVM](docs/how-to/local-quality-gate.md). GitHub Actions não faz parte
do executor atual. A configuração das ferramentas de manutenção não precisa ser o primeiro
exercício do aluno para explorar a base.

## Referências

- [Guia inicial](docs/how-to/develop-from-template.md)
- [Estado e limites da base](NOTES.md)
- [Arquitetura e pontos de extensão](docs/specs/base-app.md)
- [Decisões arquiteturais](docs/adr/)
- [Roadmap do núcleo — referência de manutenção](docs/plan/implementation-waves.md)
- [Licença MIT](LICENSE)
