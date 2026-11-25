# ADR 0002 — App mobile com React Native e Expo

- **Status:** proposed
- **Data:** 2026-11-24

## Contexto

O objetivo é publicar na App Store e no Google Play com um só código e o mínimo de atrito de
build e assinatura. O público é de alunos que estão começando: o caminho precisa ser o mais
curto possível entre o clone e um build instalado no aparelho.

O base-app só tem login por e-mail, não rastreia o usuário e não envia notificações push.
Por isso o app não carrega SDKs de login social, de crescimento ou de atribuição, não pede
permissão de ATT (App Tracking Transparency) e não registra token de push.

## Decisão

- React Native com **Expo** em Continuous Native Generation: as pastas `ios/` e `android/` não
  são commitadas; tudo o que é nativo vem de `app.config.ts` e de config plugins.
- **EAS Build** e **EAS Submit** para build e envio às lojas; **EAS Update** para OTA, com
  `runtimeVersion` por fingerprint e atualizações assinadas (ADR 0012).
- **Expo Router** para navegação por arquivos. As rotas em `src/app/` são finas e só compõem
  telas.
- **TypeScript strict** com `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`.
- Nova arquitetura do React Native e Hermes ligados (padrão do Expo).
- Organização por feature: `src/features/<feature>/{model,api,adapters,ui}`. O domínio de
  verdade mora no servidor; `model/` guarda só regras de apresentação e fluxo (máquinas de
  estado de login, gates de boot), puras e testadas.
- Diferença entre plataformas com `Platform.select` ou arquivos `*.ios.tsx` e `*.android.tsx`
  do Metro. Nunca cópia de tela ou de `package.json` por plataforma.
- Bibliotecas principais: `@supabase/supabase-js`, `react-native-purchases` e
  `react-native-purchases-ui`, `expo-secure-store`, TanStack Query, react-hook-form, Zod,
  i18next, `@sentry/react-native`, `expo-updates`.
- **Fora do base-app:** login com Google e Apple, notificações push, ATT e SDKs de analytics ou
  atribuição. Versões derivadas os acrescentam pela `mobileExtensions` (ADR 0013), inclusive os
  plugins nativos em `app.config.ts`.
- Versões móveis são fixadas no lockfile e devem seguir a tabela de compatibilidade oficial do
  SDK do Expo. Na implementação da onda 3 (2026-11-24), a versão estável mais recente é o Expo
  SDK 58 (`expo` 58.0.26), que corresponde ao React Native 0.88 e ao React 19.3; o Expo Router
  recomendado para essa linha é 58.0.32. Os patches exatos usados ficam em `apps/mobile/package.json`
  e `pnpm-lock.yaml`; upgrades seguem o guia da versão do SDK, não o `latest` isolado de cada
  pacote nativo.

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| Flutter | Exigiria Dart e não compartilharia contratos TypeScript com a API |
| React Native sem Expo | Mais controle nativo, mas build e assinatura manuais; config plugins cobrem o que o template precisa |
| Nativo (Swift e Kotlin) | Dois códigos; inviável para o público e o prazo do template |

## Consequências

- SDK nativo novo entra por config plugin. Se não existir, escreve-se um em
  `apps/mobile/plugins/`, com teste do `app.config` gerado.
- O Expo Go não serve, porque há módulos nativos; o desenvolvimento usa o dev client.
- Os builds dependem do EAS (pago acima da cota gratuita). Build local continua possível com
  `eas build --local` ou `expo prebuild`.
- A configuração base não contém ID de projeto EAS nem certificado de OTA. Updates permanecem
  desligados até o operador fornecer `EAS_PROJECT_ID`, certificado público, `keyid` e, se
  necessário, uma URL HTTPS; com o conjunto completo, o app configura `ON_LOAD`, runtime por
  fingerprint e validação de assinatura. A chave privada nunca entra no app nem no repositório.
- O template de desenvolvimento não publica source maps no Sentry automaticamente. A integração
  de runtime continua disponível; upload só pode ser habilitado num fluxo de release próprio,
  com projeto configurado e credencial de upload externa.
- Sem login por terceiros, "Sign in with Apple" não é exigido; sem rastreamento, o manifesto de
  privacidade e o formulário Data Safety ficam curtos (how-to de publicação).

## Dependências transitivas — verificação de 2026-11-25

O OSV encontrou oito ocorrências vulneráveis no grafo Expo/EAS. Foram fixadas,
com versões estáveis conferidas no npm e pins explícitos no workspace/lockfile:

| Dependência | Versão corrigida | Referência |
| --- | --- | --- |
| `diff@7` | `9.0.0` | [GHSA-73rr-hh4g-fpgx](https://osv.dev/vulnerability/GHSA-73rr-hh4g-fpgx) |
| `glob@10/13` | `14.0.6` | [GHSA-3g3m-2fjr-6pw4](https://osv.dev/vulnerability/GHSA-3g3m-2fjr-6pw4) |
| `minimatch@9/10` | `11.0.9` | [GHSA-g3hv-75wg-m249](https://osv.dev/vulnerability/GHSA-g3hv-75wg-m249) |
| `ts-deepmerge@6` | `8.0.0` | [GHSA-87mf-gv2c-c62c](https://osv.dev/vulnerability/GHSA-87mf-gv2c-c62c) |
| `uuid@7/8` | `11.1.1` | [GHSA-w5hq-g745-h8pq](https://osv.dev/vulnerability/GHSA-w5hq-g745-h8pq) |

`uuid@11.1.1` é a última versão estável da linha CommonJS compatível com os
consumidores legados; a versão global mais recente, 14.0.3, é ESM. Os outros
pins são os estáveis mais recentes consultados e respeitam a idade mínima de
24 horas. Não foram alteradas as versões do Expo SDK nem do React Native.

EAS CLI 27.11.0 ainda importa o export default antigo de `ts-deepmerge`. O patch
versionado em `patches/eas-cli@27.11.0.patch` troca somente essa importação e
chamada pelo export nomeado `merge` da versão corrigida. Deve ser removido
quando o EAS adotar a API atual. Isso não dispensa builds EAS reais.

`react-dom@19.3.0` fica explícito para corresponder ao React 19.3.0 exigido pelo
SDK. Permanece o aviso de peer do loader legado `@expo/require-utils@55`, que
anuncia TypeScript 5; o projeto usa TypeScript 6.0.3. A validação local de
configuração não substitui o aceite de build nativo/hospedado.
