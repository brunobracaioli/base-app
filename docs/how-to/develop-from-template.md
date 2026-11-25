# Desenvolver a partir do template

Este guia ajuda a clonar e executar o código-fonte do base-app. Ele cobre a casca local do
site e do app mobile; não significa que os fluxos de produto estejam prontos. A lista de ondas,
as specs e o estado validado continuam em [NOTES.md](../../NOTES.md) e no
[plano de implementação](../plan/implementation-waves.md).

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

Com a onda 3 integrada, inicie o servidor Expo na raiz:

```bash
pnpm --filter mobile start
```

Esse script compila os pacotes de runtime e inicia o Metro com o fluxo de development client.
Para abrir a interface, use um development client local já instalado. Expo Go não é compatível
com os módulos nativos deste app. Um build nativo local pode ser iniciado com
`pnpm --filter mobile android` ou `pnpm --filter mobile ios`; esses comandos exigem a
toolchain da plataforma e não são builds EAS nem builds de loja.

O registro mobile começa vazio em `apps/mobile/src/extensions/index.ts`. O site também começa
com os registros de extensão vazios. Sem variáveis de integração, a casca pode ser aberta para
examinar navegação, idioma, tema e estados da interface. A faixa de sem conexão só informa o
estado visto pelo NetInfo; ela não implementa armazenamento ou operações offline.

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

Supabase Auth e RevenueCat precisam de projetos e configuração próprios para um app derivado.
As variáveis públicas correspondentes estão reservadas no exemplo mobile, mas isso não ativa
fluxos: login ainda não está implementado (onda 6) e compra/restore/paywall ainda não estão
implementados (onda 7). Telas reservadas não são prova dessas funcionalidades. Exclusão de conta
e exportação de dados pertencem às ondas 9 e 10.

`pnpm bootstrap:init` pertence à onda 11; não é necessário para clonar, instalar ou abrir a
casca deste repositório. Provisionar projeto, configurar contas EAS/lojas e fazer builds ou
deploys é trabalho posterior do app derivado, não um requisito para entregar ou explorar o
código-fonte do template.

## Smoke check do clone

1. Confira `node --version` e `pnpm --version`; devem corresponder a `.nvmrc` e
   `packageManager`.
2. Faça a instalação congelada e confirme que `pnpm --filter web dev` serve a página local.
3. Com um development client local disponível, rode `pnpm --filter mobile start` e abra a
   casca sem credenciais de Supabase ou RevenueCat. Confira os registros de extensão vazios.
4. Rode os gates locais existentes: `pnpm turbo run lint typecheck test`,
   `pnpm --filter web build` e `pnpm architecture:check`. Para o gate integral e seu recibo,
   siga [Executar a bateria local ou numa KVM](local-quality-gate.md).

A evidência registrada para a onda 2 ainda mostra `supabase test db` reprovando critérios de
privilégios gerenciados e acesso às contagens de auditoria; o teste hospedado S-TM-4 também está
pendente. Consulte o [relatório de verificação das ondas 1–3](../plan/waves-1-3-verification.md)
e `NOTES.md` antes de interpretar gates de TypeScript/web como aceite do banco. Essa pendência
não impede entregar o código-fonte; ela impede declarar a onda 2 concluída.
