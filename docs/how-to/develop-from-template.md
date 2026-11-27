# Desenvolver a partir do template

Este guia orienta o primeiro uso do starter. Comece pelo inventário do
[README](../../README.md), que separa implementação, configuração e trabalho futuro.
O [NOTES](../../NOTES.md) registra o estado verificado; o roadmap do núcleo não é
uma lista obrigatória de tarefas para o produto do aluno.

Na cópia do aluno, personalize `packages/config/src/product.config.ts` e registre
a ideia/primeiro fluxo em `AGENTS.bootstrap.md`, seguindo o
[modelo do derivado](../reference/AGENTS.bootstrap.example.md). O agente deve escrever
a spec do produto e trabalhar na funcionalidade pedida, preservando os controles
da base. Não precisa implementar cobrança ou concluir as ondas futuras para começar.

## Caminho rápido: `pnpm dev`

Para desenvolver com login de verdade sem criar contas de backend (o iPhone pede só uma conta
Expo grátis), siga o tutorial
[primeira hora](../tutorials/primeira-hora.md). Com Docker ligado, `pnpm dev` sobe um backend
local só seu (Supabase Auth, Postgres, caixa de e-mail, Redis e a API) e abre o app no Expo Go.
Detalhes e modelo de segurança: [ambiente local com `pnpm dev`](local-dev-stack.md). As seções
abaixo descrevem as peças isoladas e o caminho para o backend hospedado.

## Ferramentas e instalação

O repositório fixa Node.js `24.22.3` em `.nvmrc` e pnpm `12.23.0` em
`package.json`. Ative essas versões antes de instalar:

```bash
nvm install
nvm use
corepack enable
pnpm install --frozen-lockfile
```

O app depende dos pacotes de runtime `@base-app/config` e `@base-app/contracts`.
O script mobile abaixo os compila automaticamente; para compilá-los separadamente:

```bash
pnpm --filter @base-app/config build
pnpm --filter @base-app/contracts build
```

## Abrir o site local

Na raiz do repositório:

```bash
pnpm --filter web dev
```

Abra `http://localhost:3000`. O wrapper usa `localhost:3000` como host permitido quando
`APP_HOST` não está configurado. A página inicial atual é uma tela simples da fundação; ela não
comprova login, banco ou cobrança funcionando.

Variáveis locais do servidor, quando necessárias, ficam em `.env.local` na raiz. O wrapper Next
lê esse arquivo em `dev` e `start`; variáveis já exportadas no processo têm precedência. A
página inicial não exige esse arquivo.

```bash
cp .env.example .env.local
```

O exemplo contém somente nomes, sem valores. Nunca adicione credenciais ao código ou ao app
mobile.

## Abrir a casca mobile

Inicie o servidor Expo na raiz:

```bash
pnpm --filter mobile start
```

Esse script compila os pacotes de runtime e inicia o Metro para o **Expo Go** (`expo start
--go`): leia o QR code com o Expo Go do SDK 58. O núcleo não usa módulo nativo fora do Expo Go
([ADR 0002](../adr/0002-mobile-expo-react-native.md), emenda de 2026-11-27).

Quando o produto precisar de build de loja, OTA assinada ou um módulo nativo fora do Expo Go,
use o development client: `pnpm --filter mobile start:dev-client`, com um build instalado por
`pnpm --filter mobile android` ou `pnpm --filter mobile ios` (exigem a toolchain da plataforma;
não são builds EAS nem de loja). Ficar na tela do Expo DevLauncher não significa que o app foi
aberto.

O registro mobile começa vazio em `apps/mobile/src/extensions/index.ts`. O site também começa
com os registros de extensão vazios. Sem variáveis de integração,
o runtime de Auth retorna indisponibilidade; nenhum login é simulado. A existência
das telas, temas e idiomas não comprova um login conectado. A preservação de sessão
em falhas temporárias de rede não transforma toda funcionalidade em operação offline.

Se precisar configurar variáveis públicas do app, o arquivo local fica em
`apps/mobile/.env.local`, que o Expo carrega a partir da pasta do app:

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
```

O `pnpm dev` preenche esses campos para o backend local. Qualquer valor `EXPO_PUBLIC_*` é
incorporado ao bundle e não pode ser secreto. As URLs da API e do Supabase exigem HTTPS; a única
exceção é bundle de desenvolvimento (`__DEV__`) apontando para `localhost` ou IP de rede
privada, que é como o `pnpm dev` funciona. Builds de release continuam só com HTTPS, sem
desativar ATS nem permitir tráfego em texto puro.

## O que ainda requer configuração do app derivado

O login por e-mail está implementado no código W6. Localmente, `pnpm dev` fornece Supabase Auth
e API sem contas externas; para usuários reais, exige Supabase Auth e a API hospedados e
configurados para o produto. No app, os campos públicos são
`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e
`EXPO_PUBLIC_API_URL`; no servidor, seguir a seção de perfil/consentimentos abaixo.
Use somente chave pública no app e HTTPS alcançável pelo aparelho.

RevenueCat ainda é uma evolução planejada: não é necessário criar essa conta para
começar a explorar a base. Compra, restore e paywall ainda não estão implementados.
Exclusão de conta completa e exportação de dados também continuam planejadas.
Telas reservadas e variáveis vazias não comprovam essas funcionalidades.

`pnpm bootstrap:init` pertence à onda 11; não é necessário para clonar, instalar ou abrir a
casca deste repositório. Provisionar projeto, configurar contas EAS/lojas e fazer builds ou
deploys é trabalho posterior do app derivado, não um requisito para entregar ou explorar o
código-fonte do template.

## Smoke check do clone

1. Confira `node --version` e `pnpm --version`; devem corresponder a `.nvmrc` e
   `packageManager`.
2. Faça a instalação congelada e confirme que `pnpm --filter web dev` serve a página local.
3. Rode `pnpm dev`, leia o QR code com o Expo Go e crie uma conta com o código que chega em
   `http://127.0.0.1:58324`. Registre separadamente se o app abriu e se o login conectado
   funcionou; são resultados diferentes.
4. Rode os gates locais existentes: `pnpm turbo run lint typecheck test`,
   `pnpm --filter web build` e `pnpm architecture:check`. Para o gate integral e seu recibo,
   siga [Executar a bateria local ou numa KVM](local-quality-gate.md).

As fundações das ondas 1–3 passaram pelos gates de código e pelos testes reais de banco
registrados no [relatório de verificação](../plan/waves-1-3-verification.md). A v1 completa
continua dependendo das ondas seguintes. A baseline consolidada atende bancos novos do template;
um projeto que já aplicou as migrations experimentais antigas precisa de um plano próprio.
A confirmação de configuração hospedada do S-TM-4 permanece no checklist do derivado.

## API de perfil e consentimentos

A onda 4 acrescenta GET/PATCH `/api/v1/me` e POST `/api/v1/me/consents`, todos
com Bearer token verificado. No servidor do derivado, preencha APP_HOST,
SUPABASE_URL, DATABASE_URL (usuário `api_runtime`), DATABASE_CA_CERT e as duas
variáveis UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN em `.env.local`.
O URL do Supabase usa HTTPS; HTTP de loopback é aceito somente em dev/test.
Sem essas integrações, uma rota protegida falha fechada; a página básica e
o build continuam disponíveis. Nunca use chave administrativa no runtime.

Veja a [prova da onda 4](../plan/wave-4-verification.md). O código de login mobile
está descrito na [verificação W6](../plan/wave-6-verification.md). O smoke nativo
completo ainda não foi aprovado; prepare e confira esse caminho no ambiente da aula.
