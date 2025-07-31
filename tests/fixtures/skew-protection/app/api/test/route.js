export async function GET() {
  return Response.json({ 
    message: 'Hello from API route',
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || 'not-set'
  })
}