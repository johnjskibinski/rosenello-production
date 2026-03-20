import dotenv from 'dotenv';
dotenv.config();

export const env = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  supabase: {
    url: process.env.SUPABASE_URL!,
    serviceKey: process.env.SUPABASE_SERVICE_KEY!,
  },
  lp: {
    server: process.env.LP_SERVER!,
    clientId: process.env.LP_CLIENT_ID!,
    username: process.env.LP_USERNAME!,
    password: process.env.LP_PASSWORD!,
    appKey: process.env.LP_APP_KEY!,
    baseUrl: `https://${process.env.LP_SERVER}.leadperfection.com`,
  },
};
