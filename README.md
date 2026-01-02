# Project Setup and Preparation

This project contains multiple services. Below is how to set up and prepare to run the `review-ingestion` and `ai-analysis` services.

---

## Prerequisites

- Node.js (v16 or newer recommended)
- Yarn or npm
- Google Cloud account (for Pub/Sub, Storage, and Logging)
- [Google Cloud SDK](https://cloud.google.com/sdk) (optional, for local emulation and authentication)

---

## 1. Clone the Repository

```bash
git clone <REPO_URL>
cd <REPO_FOLDER>
```

---

## 2. Install Dependencies

Each service contains its own dependencies. Install them for each service you intend to run. For example:

```bash
# For review-ingestion service
cd services/review-ingestion
npm install

# For ai-analysis service
cd ../ai-analysis
npm install
```

---

## 3. Configure Environment Variables

Copy the example environment file and update values as needed for each service. For example:

```bash
# For review-ingestion service
cd services/review-ingestion
cp .env.example .env

# For ai-analysis service
cd ../ai-analysis
cp .env.example .env
```

Fill the `.env` file(s) in each service with the correct Google Cloud project, Pub/Sub topic, Storage bucket, and credentials (see the service's README or source for required variables).

---

## 4. Google Cloud Setup

- Ensure you have [Application Default Credentials](https://cloud.google.com/docs/authentication/provide-credentials-adc) set up for local development or provide a service account JSON key via the environment variable `GOOGLE_APPLICATION_CREDENTIALS`.

- Create any required Pub/Sub topics and Storage buckets using `gcloud` or Google Cloud Console.

---

## 5. Running the Services

Start each service locally:

```bash
# Run review-ingestion backend
cd services/review-ingestion
npm start

# Run ai-analysis service
cd ../ai-analysis
npm start
```

---

## 6. Testing

- Use tools like [Postman](https://www.postman.com/) or `curl` to send requests to the services and validate their responses.
- You can check `/health` endpoints for health checks.

---

## 7. Additional Notes

- All build outputs and environment files are git-ignored for safety.
- Cloud resources may incur charges—monitor your usage.

For further details, refer to each service's own README or documentation.
