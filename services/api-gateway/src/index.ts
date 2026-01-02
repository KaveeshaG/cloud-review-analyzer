import express, { Request, Response as ExpressResponse, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { GoogleAuth } from 'google-auth-library';

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize Google Auth
const auth = new GoogleAuth();

// Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/api/', limiter);

// Request logging
app.use((req: Request, res: ExpressResponse, next: NextFunction) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });
  
  next();
});

// Get authenticated client for service-to-service calls
async function makeAuthenticatedRequest(url: string, options: RequestInit = {}): Promise<globalThis.Response> {
  try {
    // Create a new URL object to get the origin (audience)
    const targetUrl = new URL(url);
    const audience = targetUrl.origin;
    
    console.log(`Making authenticated request to: ${url}`);
    console.log(`Audience: ${audience}`);
    
    // Get the ID token client
    const client = await auth.getIdTokenClient(audience);
    
    // Get headers with the ID token
    const headers = await client.getRequestHeaders(url);
    
    console.log(`Got ID token for request`);
    
    // Merge with provided headers
    const mergedHeaders = {
      ...headers,
      ...options.headers,
    };
    
    // Make the request
    const response = await fetch(url, {
      ...options,
      headers: mergedHeaders,
    });
    
    console.log(`Response status: ${response.status}`);
    
    return response;
  } catch (error) {
    console.error('Authentication error:', error);
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req: Request, res: ExpressResponse) => {
  res.json({ 
    status: 'healthy', 
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    reviewIngestionConfigured: !!process.env.REVIEW_INGESTION_URL,
    analyticsConfigured: !!process.env.ANALYTICS_URL
  });
});

// Root endpoint
app.get('/', (req: Request, res: ExpressResponse) => {
  res.json({
    service: 'AI-Powered Product Review Analyzer',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      submitReview: 'POST /api/reviews',
      getAnalytics: 'GET /api/analytics/:productId',
      getReview: 'GET /api/reviews/:reviewId'
    }
  });
});

// Submit review endpoint
app.post('/api/reviews', async (req: Request, res: ExpressResponse) => {
  try {
    const reviewIngestionUrl = process.env.REVIEW_INGESTION_URL;
    
    if (!reviewIngestionUrl) {
      console.error('REVIEW_INGESTION_URL not configured');
      return res.status(500).json({
        error: 'Service configuration error',
        message: 'Review ingestion service is not configured'
      });
    }

    const targetUrl = `${reviewIngestionUrl}/ingest`;
    console.log(`Submitting review to: ${targetUrl}`);

    const response: globalThis.Response = await makeAuthenticatedRequest(targetUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body)
    });
    
    const responseText = await response.text();
    console.log(`Response: ${response.status} - ${responseText.substring(0, 200)}`);
    
    if (!response.ok) {
      if (response.status === 400) {
        try {
          return res.status(400).json(JSON.parse(responseText));
        } catch {
          return res.status(400).json({ error: responseText });
        }
      }
      
      throw new Error(`Review ingestion failed: ${response.status} - ${responseText.substring(0, 100)}`);
    }
    
    const data = JSON.parse(responseText);
    res.status(201).json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to submit review:', errorMessage);
    
    res.status(500).json({ 
      error: 'Failed to process review',
      message: errorMessage
    });
  }
});

// Get analytics endpoint
app.get('/api/analytics/:productId', async (req: Request, res: ExpressResponse) => {
  try {
    const { productId } = req.params;
    const analyticsUrl = process.env.ANALYTICS_URL;
    
    if (!analyticsUrl) {
      console.error('ANALYTICS_URL not configured');
      return res.status(500).json({
        error: 'Service configuration error',
        message: 'Analytics service is not configured'
      });
    }

    const targetUrl = `${analyticsUrl}/analytics/${productId}`;
    console.log(`Fetching analytics from: ${targetUrl}`);

    const response: globalThis.Response = await makeAuthenticatedRequest(targetUrl);
    
    const responseText = await response.text();
    console.log(`Response: ${response.status} - ${responseText.substring(0, 200)}`);
    
    if (response.status === 404) {
      try {
        return res.status(404).json(JSON.parse(responseText));
      } catch {
        return res.status(404).json({ error: 'Product not found', productId });
      }
    }
    
    if (!response.ok) {
      throw new Error(`Analytics service failed: ${response.status} - ${responseText.substring(0, 100)}`);
    }
    
    const data = JSON.parse(responseText);
    res.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch analytics:', errorMessage);
    
    res.status(500).json({ 
      error: 'Failed to fetch analytics',
      message: errorMessage
    });
  }
});

// Get specific review
app.get('/api/reviews/:reviewId', async (req: Request, res: ExpressResponse) => {
  try {
    const { reviewId } = req.params;
    const analyticsUrl = process.env.ANALYTICS_URL;
    
    if (!analyticsUrl) {
      console.error('ANALYTICS_URL not configured');
      return res.status(500).json({
        error: 'Service configuration error',
        message: 'Analytics service is not configured'
      });
    }

    const targetUrl = `${analyticsUrl}/review/${reviewId}`;
    console.log(`Fetching review from: ${targetUrl}`);

    const response: globalThis.Response = await makeAuthenticatedRequest(targetUrl);
    
    const responseText = await response.text();
    
    if (response.status === 404) {
      try {
        return res.status(404).json(JSON.parse(responseText));
      } catch {
        return res.status(404).json({ error: 'Review not found', reviewId });
      }
    }
    
    if (!response.ok) {
      throw new Error(`Analytics service failed: ${response.status} - ${responseText.substring(0, 100)}`);
    }
    
    const data = JSON.parse(responseText);
    res.json(data);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to fetch review:', errorMessage);
    
    res.status(500).json({ 
      error: 'Failed to fetch review',
      message: errorMessage
    });
  }
});

// Error handling middleware
app.use((err: Error, req: Request, res: ExpressResponse, next: NextFunction) => {
  console.error('Unhandled error:', err);
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req: Request, res: ExpressResponse) => {
  res.status(404).json({ 
    error: 'Not found',
    path: req.path
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 API Gateway listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log(`Review Ingestion URL: ${process.env.REVIEW_INGESTION_URL || 'NOT SET'}`);
  console.log(`Analytics URL: ${process.env.ANALYTICS_URL || 'NOT SET'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});