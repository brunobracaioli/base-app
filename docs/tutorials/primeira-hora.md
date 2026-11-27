# Primeira hora: do zero ao seu app no celular

Ao final deste tutorial, você terá:

- uma cópia própria da base;
- um backend só seu rodando no seu computador, com login de verdade, sem conta em serviço de
  backend (use a rede de casa ou o hotspot do celular, não Wi-Fi público);
- o app aberto no seu celular pelo Expo Go;
- a primeira mudança feita com o Claude Code e vista no celular na hora.

Tempo estimado: 30 a 60 minutos, a maior parte em downloads. Por isso a parte 1 deve ser feita
**antes da aula**.

## Parte 1: antes da aula (instale e baixe tudo)

1. **Git**: [git-scm.com/downloads](https://git-scm.com/downloads).
2. **Node.js 24 LTS**: [nodejs.org](https://nodejs.org) (versão 24.22.3 ou mais nova dentro da
   24). Confira com `node --version`. A versão 25 ou superior não serve.
3. **pnpm**, pelo Corepack, que já vem com o Node 24: `corepack enable`. No Windows, rode no
   PowerShell **como administrador** se der erro de permissão.
4. **Docker Desktop**: [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/).
   No Windows, aceite instalar o WSL 2 se o instalador pedir e reinicie. Abra o Docker Desktop
   e espere ele dizer que está rodando.
5. **Expo Go** no celular: App Store ou Google Play. Atualize se já tiver instalado.
   **Tem iPhone?** Crie uma conta Expo grátis em [expo.dev/signup](https://expo.dev/signup) (com
   e-mail e senha) e entre nela no Expo Go. No iPhone, o Expo Go só abre o seu projeto com o
   mesmo login no computador (passo 8). Android não precisa.
6. **Claude Code**: [claude.com/claude-code](https://claude.com/claude-code). Faça login.
7. **Crie o seu repositório**: no GitHub do template, clique em **Use this template → Create a
   new repository**, dê o nome do seu app e escolha **Private**. Depois clone:

   ```bash
   git clone https://github.com/<seu-usuario>/<seu-app>.git
   cd <seu-app>
   ```

8. **Baixe as dependências e as imagens** (é aqui que vai a maior parte do download):

   ```bash
   pnpm install
   pnpm expo:login   # só com iPhone: a mesma conta Expo do Expo Go
   pnpm dev
   ```

   Na primeira vez, o `pnpm dev` baixa as imagens do Supabase e do Redis (alguns GB). Quando
   aparecer **"Ambiente local pronto"** e um QR code, está tudo certo. Pode apertar `Ctrl+C` e
   rodar `pnpm dev:stop`. Se algo falhar, anote a mensagem e traga para a aula.

## Parte 2: na aula

### 1. Suba o ambiente

Com o Docker Desktop aberto, na pasta do projeto:

```bash
pnpm dev
```

Espere a caixa **"Ambiente local pronto"**. Ela mostra o endereço que você vai usar já já:

- **E-mails com os códigos de login**: `http://127.0.0.1:58324`. Abra no navegador do computador.

Deixe esse terminal aberto. Ele é o seu servidor.

### 2. Abra o app no celular

1. Conecte o celular ao **mesmo Wi-Fi** do computador.
2. **iPhone**: abra a câmera e aponte para o QR code. **Android**: abra o Expo Go e toque em
   **Scan QR code**.
3. No iPhone, se aparecer o pedido de acesso à **rede local**, permita.
4. No Windows, se aparecer o aviso do firewall sobre o Node.js, permita em **redes privadas**.

O app abre na tela de entrada.

### 3. Crie a sua conta

1. No app, escolha criar conta e digite o seu e-mail.
2. O e-mail **não vai para a sua caixa de verdade**: ele chega na caixa local. Abra
   `http://127.0.0.1:58324` no computador, abra a mensagem e copie o código de 10 dígitos.
3. Digite o código no app e defina a senha.

Pronto: você tem um usuário de verdade no seu banco local, criado pelo mesmo Supabase Auth que
o app usaria em produção.

### 4. Dê o nome do seu app

Abra `packages/config/src/product.config.ts` e troque `displayName` (o nome que aparece no
app) e `slug` (um identificador curto, sem espaços). Esse arquivo é lido quando o servidor
inicia: pare o `pnpm dev` com `Ctrl+C`, rode `pnpm dev` de novo e recarregue o app no Expo Go
(chacoalhe o celular → **Reload**).

Mudanças nas telas, ao contrário, aparecem no celular sozinhas, segundos depois de salvar.

### 5. Comece o seu produto com o Claude Code

Abra **outro terminal** na pasta do projeto (o primeiro continua com o `pnpm dev`) e rode
`claude`. Comece com:

> Este repositório é a base do meu produto: [descreva a ideia em 2 ou 3 frases]. Leia
> README.md, CLAUDE.md e AGENTS.md. O ambiente local já está rodando com `pnpm dev`. Registre as
> decisões do meu produto em AGENTS.bootstrap.md e proponha uma spec curta para o primeiro
> fluxo útil. Depois de eu aprovar a spec, implemente com testes. Não continue as ondas internas
> do template.

Cada mudança que o Claude Code fizer no app aparece no celular em segundos. Se ele criar
uma tabela nova (migration), pare o `pnpm dev` com `Ctrl+C` e rode `pnpm dev` de novo para
aplicá-la.

## Se algo der errado

| Sintoma | O que fazer |
|---------|-------------|
| "O Docker não está rodando" | abra o Docker Desktop e espere iniciar |
| iPhone: "You need to be signed in to Expo Go and Expo CLI" | rode `pnpm expo:login` no computador e entre no Expo Go com a mesma conta Expo; depois toque em **Try again** |
| Expo Go mostra "The request timed out" | o firewall está bloqueando: veja a seção de problemas do [ambiente local](../how-to/local-dev-stack.md#problemas-comuns) (rede "Pública" no Windows, WSL) |
| O QR code abre mas o app não carrega | confira o mesmo Wi-Fi; Wi-Fi de visitantes isola os aparelhos: ligue o hotspot do celular e conecte o computador nele |
| "porta em uso" | `pnpm dev:stop` e rode `pnpm dev` de novo |
| O código não chega | ele está em `http://127.0.0.1:58324`, não no seu e-mail; vale 5 minutos |
| Erro de versão do Node | instale o Node 24 (não 22, não 25) |
| O Expo Go diz que o projeto é incompatível | atualize o Expo Go na loja |

Mais detalhes, endereços e o modelo de segurança do ambiente local:
[ambiente local com `pnpm dev`](../how-to/local-dev-stack.md).

## Depois da aula

Este ambiente é para desenvolver. Para publicar o app (Supabase hospedado, API na Vercel,
build nas lojas), siga [desenvolver a partir do template](../how-to/develop-from-template.md).
