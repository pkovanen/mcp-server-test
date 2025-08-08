# Simple Node.js Service for Google Cloud Run

A minimal Node.js Express.js service designed for easy deployment to Google Cloud Run.

## Features

- Simple Express.js server
- Health check endpoint
- JSON API responses
- Docker containerization
- Ready for Google Cloud Run deployment

## Local Development

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

The server will start on `http://localhost:8080`

### Available Endpoints

- `GET /` - Main endpoint with service information
- `GET /health` - Health check endpoint
- `GET /api/hello?name=YourName` - Personalized hello message

## Deployment to Google Cloud Run

### Prerequisites

- Google Cloud SDK installed and configured
- Docker installed
- Google Cloud project with billing enabled

### Steps

1. **Build and push the Docker image:**
```bash
# Set your project ID
export PROJECT_ID=your-project-id

# Build the image
docker build -t gcr.io/$PROJECT_ID/simple-service .

# Push to Google Container Registry
docker push gcr.io/$PROJECT_ID/simple-service
```

2. **Deploy to Cloud Run:**
```bash
gcloud run deploy simple-service \
  --image gcr.io/$PROJECT_ID/simple-service \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

### Alternative: Deploy directly with gcloud

You can also deploy directly without building locally:

```bash
gcloud run deploy simple-service \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080
```

## Environment Variables

The service uses the following environment variables:

- `PORT` - Port to listen on (default: 8080)
- `NODE_ENV` - Environment (development/production)

## Container Details

- Base image: `node:18-alpine`
- Runs as non-root user for security
- Optimized for production with `npm ci --only=production`
- Exposes port 8080

## Testing

Test the endpoints locally:

```bash
# Test main endpoint
curl http://localhost:8080/

# Test health check
curl http://localhost:8080/health

# Test hello endpoint
curl http://localhost:8080/api/hello?name=John
``` 