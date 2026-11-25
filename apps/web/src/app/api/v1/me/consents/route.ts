import { defineRoute } from '../../../../../platform/http';
import { coreRouteDefinitions } from '../../../../../platform/http/core-routes';

export const POST = defineRoute(coreRouteDefinitions.acceptConsent);
