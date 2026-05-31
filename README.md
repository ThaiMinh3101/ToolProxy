# Tool Proxy (Puppeteer + Đa tài khoản + Xoay proxy)

Tool này giúp tự động hoá web bằng Puppeteer, chạy nhiều tài khoản song song, có proxy auth, tự xoay IP, có dashboard quản lý và API.

## 1) Chạy nhanh (1 phút)

```bash
cd ToolProxy
npm install
npm run dev
```

Sau khi chạy, terminal sẽ in sẵn link dashboard, ví dụ:

- `http://127.0.0.1:3000/`
- `http://localhost:3000/`
- `http://<LAN_IP>:3000/`

Mở link đó để dùng UI.

## 2) Cách dùng trên UI

1. Vào mục **Proxy Management**:
   - Thêm 1 proxy: nhập đúng format `IP:Port:Username:Password`.
   - Thêm nhiều proxy: mỗi dòng 1 proxy (hoặc ngăn cách bằng dấu phẩy).
2. Vào mục **Account Management**:
   - Nhập `accountId` (ví dụ `account-1`).
   - Nhập `targetUrl` (mặc định thường dùng `https://httpbin.org/ip`).
   - Giữ `Autostart` nếu muốn chạy ngay sau khi thêm.
3. Theo dõi trạng thái:
   - Bảng account cho biết đang chạy hay dừng, proxy đang dùng, số lần success/failure.
   - Nút `Rotate` để xoay proxy thủ công cho từng account.
   - Nút `Rotate All` để xoay toàn bộ account.

## 3) Đóng app có mất dữ liệu không?

Hiện tại **có lưu lại** (mặc định):

- Lưu file state: `./data/state.json`
- Lưu:
  - Danh sách proxy
  - Danh sách account (`accountId`, `targetUrl`, trạng thái chạy/dừng)

Khi mở lại server, app tự khôi phục dữ liệu từ file state.

Ngoài ra log runtime lưu ở:

- `./logs/tool-proxy.log`

## 4) Biến môi trường quan trọng

Bạn có thể copy file mẫu:

```bash
cp .env.example.env
```

Các biến thường dùng:

- `PORT=3000`: cổng server
- `HOST=0.0.0.0`: host bind
- `ROTATION_MODE=interval|perRequest`: chế độ xoay proxy
- `ROTATION_INTERVAL_MS=120000`: chu kỳ xoay khi ở `interval`
- `TASK_INTERVAL_MS=30000`: khoảng cách giữa các vòng chạy task
- `TARGET_URL=https://httpbin.org/ip`: URL mặc định cho account
- `PERSIST_STATE=true|false`: bật/tắt lưu state
- `STATE_FILE_PATH=./data/state.json`: đường dẫn file state
- `LOG_FILE_PATH=./logs/tool-proxy.log`: đường dẫn file log

## 5) API nhanh (nếu không dùng UI)

Thêm proxy:

```bash
curl -X POST http://localhost:3000/proxies \
  -H "Content-Type: application/json" \
  -d '{"proxy":"1.2.3.4:8000:user:pass"}'
```

Thêm account:

```bash
curl -X POST http://localhost:3000/accounts \
  -H "Content-Type: application/json" \
  -d '{"accountId":"account-1","targetUrl":"https://httpbin.org/ip","autostart":true}'
```

Xem session:

```bash
curl http://localhost:3000/sessions
```

Xoay proxy toàn bộ:

```bash
curl -X POST http://localhost:3000/rotate \
  -H "Content-Type: application/json" \
  -d '{}'
```

## 6) Logs trên dashboard

- `Current session only`: chỉ hiện log của lần chạy hiện tại.
- Bỏ tick để xem cả lịch sử file log.
- `Clear Logs`: xoá nội dung file log hiện tại.

## 7) Ghi chú kỹ thuật

- Proxy bắt buộc đúng format: `IP:Port:Username:Password`.
- Khi proxy lỗi hoặc bị chặn, hệ thống tự retry + xoay proxy khác.
- Hỗ trợ graceful shutdown (`Ctrl+C`): dừng browser sạch và lưu state trước khi thoát.
