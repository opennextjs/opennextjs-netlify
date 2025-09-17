const { http, HttpResponse, passthrough } = require('msw')
// eslint-disable-next-line import/extensions
const { setupServer } = require('msw/node')

const server = setupServer(
  http.get(
    'https://api.netlifysdk.com/team/:accountId/integrations/installations/meta/:siteId',
    () => {
      return HttpResponse.json([])
    },
  ),
  http.get('https://api.netlifysdk.com/site/:siteId/integrations/safe', () => {
    return HttpResponse.json([])
  }),
  http.all(/.*/, () => passthrough()),
)
server.listen()
