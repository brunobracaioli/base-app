# Por que esta arquitetura

> Explicação (Diátaxis). Este template existe porque os mesmos erros aparecem em quase todo
> app mobile feito às pressas. Cada seção abaixo descreve um erro comum, o dano que ele causa e
> o que o base-app faz no lugar.

## Como ler

Cada erro tem três partes: **o erro**, **o que acontece** e **o que o template faz**. Os
nomes entre parênteses apontam para o ADR ou a spec que registra a decisão.

## 1. Chave secreta dentro do app

**O erro.** Colocar no app uma chave de API que dá poder de administrador (banco, cobrança,
e-mail), porque "é mais fácil chamar o serviço direto do celular".

**O que acontece.** O app é um arquivo que fica na mão de qualquer pessoa. Extrair texto de um
pacote instalado leva minutos, e variáveis `EXPO_PUBLIC_*` ou equivalentes são embutidas no
bundle por desenho. A chave vaza, e quem a tiver age como o dono do projeto.

**O que o template faz.**

- O app só carrega chaves **públicas por desenho**: a publishable key do Supabase e a chave
  pública do SDK do RevenueCat. Elas só funcionam dentro das regras do servidor.
- Toda chave secreta (RevenueCat, Resend, Upstash) fica só na API, em variáveis de ambiente
  validadas no boot.
- A secret key do Supabase **nem está na API**: a exclusão de usuário usa funções do banco com
  permissão mínima (ADR 0004).
- O CI roda gitleaks e falha se um segredo entrar no repositório.

## 2. Banco exposto ao app, sem RLS

**O erro.** Ligar o app direto às tabelas (a Data API do Supabase) e esquecer de ativar RLS, ou
ativar e escrever uma política que libera tudo.

**O que acontece.** Qualquer usuário autenticado, ou até anônimo, lê e altera linhas de
outras pessoas. É o vazamento de dados mais comum em apps que usam backend como serviço.

**O que o template faz.**

- O app **não acessa tabelas**. A Data API e o `pg_graphql` ficam desligados e o schema
  `public` não tem grants.
- Só a API fala com o banco, usando um usuário sem permissão de tabela que assume um papel por
  transação (ADR 0005).
- RLS é **forçado** em toda tabela e é a *segunda* barreira: o repositório já filtra por
  `user_id`.
- Todo teste de banco confere que o usuário A não vê a linha do usuário B.

## 3. Webhook sem verificação

**O erro.** Criar uma rota que recebe eventos de pagamento e acreditar no que chega. Ou
verificar a assinatura só "se a variável de ambiente existir".

**O que acontece.** Qualquer pessoa que descubra a URL envia um evento falso e ganha uma
assinatura sem pagar. Se o segredo não estiver configurado e o código "libera", o erro de
configuração vira vulnerabilidade.

**O que o template faz.**

- O base-app **não tem webhook**: a API pergunta ao RevenueCat se o usuário tem o entitlement,
  e guarda a resposta por 60 s (ADR 0006). Quem vai receber webhooks mais tarde usa os
  verificadores do núcleo, que comparam em tempo constante e **falham fechados** se o segredo
  faltar.
- A regra geral: o que vem de fora é dado não confiável. A resposta de terceiros também passa
  por validação de schema.

## 4. JWT verificado à mão

**O erro.** Decodificar o token e ler `user_id` sem checar a assinatura, ou verificar com uma
chave compartilhada simples, sem `iss`, `aud` nem expiração, ou aceitar o algoritmo que o
próprio token pede.

**O que acontece.** Quem monta um token com o corpo que quiser é aceito como qualquer usuário.
O algoritmo `none` e a troca de algoritmo são ataques clássicos.

**O que o template faz.**

- A API não emite tokens. O Supabase Auth emite, e a API verifica com a biblioteca `jose`
  contra as chaves públicas (JWKS), com **lista fixa de algoritmos**, `iss`, `aud` e `exp`
  (ADR 0004).
- O `user_id` vem **só** do token verificado. Nenhuma rota lê usuário de body, query ou header.
- O `defineRoute` obriga a declarar a autenticação: esquecer não compila.

## 5. CORS com `*`

**O erro.** Responder `Access-Control-Allow-Origin: *` (às vezes com credenciais) para "parar
de dar erro no navegador".

**O que acontece.** Qualquer site aberto no navegador do usuário consegue chamar a API em nome
dele. CORS é uma proteção do navegador, não uma autenticação, e liberar tudo a desliga.

**O que o template faz.**

- O app mobile **não usa CORS** (não é navegador). A API **não responde a origens de
  terceiros**.
- Autenticação por `Authorization: Bearer`, não por cookie, o que também elimina CSRF.
- Headers de segurança em todas as respostas (HSTS, CSP, `nosniff`, `X-Frame-Options`).

## 6. Logs com tokens e dados pessoais

**O erro.** Usar `console.log(request)` ou gravar corpo e cabeçalhos "para depurar", e deixar
arquivos de log no repositório.

**O que acontece.** Tokens, códigos de login e e-mails acabam em arquivos, em painéis de log e
em ferramentas de terceiros, com retenção longa e muita gente com acesso. Quem lê o log passa a
poder agir como o usuário.

**O que o template faz.**

- Logs em JSON com **redaction por nome**: qualquer campo com `token`, `secret`, `password`,
  `authorization`, `cookie`, `code`, `email` ou `signature` é substituído (ADR 0009).
- Corpos de requisição **não são logados**. O usuário aparece só pelo UUID.
- `console.*` é proibido por lint; o Sentry também filtra dados pessoais.
- Um teste de redaction usa corpos reais de login e falha se algo sensível aparecer.

## 7. Cópias de tela por plataforma

**O erro.** Para resolver uma diferença entre iOS e Android, copiar o arquivo
(`LoginScreen.ios.js`, `LoginScreen-android.js`, `package-ios.json`) e editar cada cópia.

**O que acontece.** Uma correção é aplicada numa cópia e esquecida na outra. Com o tempo as
telas divergem e ninguém sabe qual é a certa.

**O que o template faz.**

- **Uma tela por fluxo.** A diferença real entre plataformas se resolve com `Platform.select`
  ou com arquivos de plataforma do Metro, dentro do mesmo componente (ADR 0002).
- Os textos ficam em arquivos de idioma (pt-BR, en, es) e o CI confere que as chaves batem.
- Nome do app, IDs e configurações moram num único arquivo, `product.config.ts` (ADR 0010).

## 8. Ausência de testes

**O erro.** "Depois eu testo." O app só é testado à mão, no simulador, antes de publicar.

**O que acontece.** Uma mudança aparentemente inocente quebra o login ou deixa a assinatura
liberada para todos, e isso só aparece depois que a loja já aprovou. Corrigir leva dias, porque
cada versão passa por nova revisão.

**O que o template faz.**

- **Pirâmide de testes:** muitos testes unitários nas regras de negócio, testes de banco
  (pgTAP) para cada política de RLS, testes de integração para cada rota e poucos fluxos de
  ponta a ponta (Maestro).
- O CI **bloqueia** o merge se os testes, a cobertura mínima (80% em `domain/` e
  `application/`), as fronteiras entre módulos ou o contrato da API não passarem.
- Dependências externas (RevenueCat, e-mail) são trocadas por **fakes** nos testes: sem rede e
  sem depender do horário.

## 9. Mais três erros que o template evita

| Erro | Consequência | Defesa |
|------|--------------|--------|
| Confiar no app para saber se o usuário pagou | App adulterado ganha acesso pago | O servidor consulta o RevenueCat; sem confirmação, não libera (falha fechada) |
| Regra de negócio dentro das rotas | Código difícil de testar e de mudar | Rotas finas; casos de uso por fatia vertical, com fronteiras checadas no CI |
| Apagar conta só "esconde" os dados | Descumpre a LGPD e as regras das lojas | Exclusão imediata de todos os dados, inclusive no RevenueCat, com teste que varre o catálogo do banco |

## O fio condutor

Quase todos esses erros vêm da mesma ideia: confiar em algo só porque "está dentro do nosso
sistema". O template parte do contrário, o **Zero Trust**: cada requisição prova quem é, cada
dado de fora é validado, cada camada se protege como se a anterior já tivesse falhado. Veja
[ADR 0003](../adr/0003-backend-nextjs-modular-monolith-on-vercel.md),
[0004](../adr/0004-supabase-auth-and-jwt-verification.md) e
[0005](../adr/0005-data-access-sql-migrations-kysely-rls.md) para os detalhes.
