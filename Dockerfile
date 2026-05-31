FROM node:20-slim

# Cài đặt thư viện hệ thống cần thiết cho Puppeteer / Chromium hoạt động ổn định trên Linux
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Thiết lập thư mục làm việc
WORKDIR /app

# Sao chép package files
COPY package*.json ./

# Cài đặt các package Node.js (Production only)
RUN npm ci --only=production

# Sao chép mã nguồn ứng dụng
COPY . .

# Tạo các thư mục dữ liệu và phân quyền ghi
RUN mkdir -p data logs profiles && chmod -R 777 data logs profiles

# Cổng dịch vụ Express API
EXPOSE 3000

# Biến môi trường mặc định
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV HEADLESS=true

# Khởi chạy dịch vụ
CMD ["node", "src/index.js"]
