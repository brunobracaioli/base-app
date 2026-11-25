import { defineRoute } from '../../../../platform/http';
import { coreRouteDefinitions } from '../../../../platform/http/core-routes';

export const GET = defineRoute(coreRouteDefinitions.getMe);
export const PATCH = defineRoute(coreRouteDefinitions.updateMe);
