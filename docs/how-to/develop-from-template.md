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

Esse script compila os pacotes de runtime e inicia o Metro com o fluxo de development client.
Para abrir a interface, use um development client local já instalado. Expo Go não é compatível
com os módulos nativos deste app. Um build nativo local pode ser iniciado com
`pnpm --filter mobile android` ou `pnpm --filter mobile ios`; esses comandos exigem a
toolchain da plataforma e não são builds EAS nem builds de loja.

Após instalar o development client, abra nele o projeto servido pelo Metro. Ficar
na tela do Expo DevLauncher não significa que o app foi aberto. O telefone/emulador
precisa alcançar o endereço de desenvolvimento com a configuração de rede apropriada.

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

Mantenha esses campos sem valores até configurar o serviço do próprio app. Qualquer valor
`EXPO_PUBLIC_*` é incorporado ao bundle e não pode ser secreto. A URL do client da API é
validada para usar HTTPS. Este guia não define uma conexão HTTPS entre aparelho e servidor local;
configure esse endpoint separadamente sem desativar ATS ou permitir tráfego em texto puro.

## O que ainda requer configuração do app derivado

O login por e-mail está implementado no código W6, mas exige Supabase Auth e a API
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
3. Com um development client local disponível, rode `pnpm --filter mobile start` e abra a
   tela inicial. Registre separadamente se abriu só o DevLauncher, se abriu a interface
   e se conseguiu usar o login conectado; são resultados diferentes.
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
