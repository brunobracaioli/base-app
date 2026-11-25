# App mobile

## Configuração local

Copie o exemplo para o arquivo local do app:

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
```

Execute os comandos Expo a partir de `apps/mobile` ou use os scripts do workspace, por
exemplo `pnpm --filter mobile start`. O Expo carrega os arquivos de ambiente a partir da pasta
do app. O `.env.local` é ignorado pelo Git.

| Grupo | Variáveis | Estado |
|---|---|---|
| API | `EXPO_PUBLIC_API_URL` | Usada pelo client HTTP. Informe uma URL HTTPS da API quando ela estiver disponível. |
| Telemetria | `EXPO_PUBLIC_SENTRY_DSN` | Opcional. Sem DSN, o envio de eventos fica desligado. O upload automático de source maps está desativado. |
| Auth | `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Chaves públicas reservadas para a onda de Auth; os fluxos de login ainda não estão implementados. |
| Assinatura | `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` | Chaves públicas reservadas para a onda de assinatura; compras ainda não estão implementadas. |
| EAS e OTA | `EAS_PROJECT_ID`, `EXPO_UPDATE_URL`, `EXPO_UPDATE_CERTIFICATE_PATH`, `EXPO_UPDATE_KEY_ID` | Deixe em branco até o responsável fornecer os dados do projeto e o certificado público de assinatura. Sem esse conjunto, OTA assinado permanece desligado. |

Todo valor com prefixo `EXPO_PUBLIC_` vai para o bundle do app. Use somente dados públicos nessas
variáveis; nunca coloque tokens privados, senha, chave privada ou credencial de loja no arquivo.

`EXPO_UPDATE_CERTIFICATE_PATH` aponta para o certificado **público** incluído no app. A chave
privada de assinatura OTA fica fora do app e do repositório, no processo de release autorizado.
Não gere IDs, certificados, chaves ou valores de conta para este template.
