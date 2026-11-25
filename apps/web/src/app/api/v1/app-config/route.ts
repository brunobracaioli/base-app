import { coreRouteDefinitions } from '../../../../platform/http/core-routes';
import { defineRoute } from '../../../../platform/http';

export const GET = defineRoute(coreRouteDefinitions.getAppConfig);
