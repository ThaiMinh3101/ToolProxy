const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, 'ToolProxy-Release');

console.log('1. Bắt đầu quá trình biên dịch ra file .exe bằng pkg...');
try {
  // Chạy lệnh pkg, bỏ qua cảnh báo
  execSync('npx pkg . --targets node18-win-x64 --out-path dist', { stdio: 'inherit' });
} catch (error) {
  console.error('Lỗi khi biên dịch:', error.message);
  process.exit(1);
}

console.log('\n2. Thiết lập thư mục Release...');
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir, { recursive: true });

console.log('3. Sao chép file .exe vào thư mục Release...');
const exeName = 'tool-proxy-automation.exe';
const srcExe = path.join(__dirname, 'dist', exeName);
const destExe = path.join(releaseDir, exeName);
if (fs.existsSync(srcExe)) {
  fs.renameSync(srcExe, destExe);
} else {
  console.error(`Không tìm thấy file ${srcExe} sau khi build.`);
  process.exit(1);
}

console.log('4. Sao chép các thư mục và file cấu hình động...');
// Hàm copy thư mục
function copyFolderSync(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(element => {
    if (fs.lstatSync(path.join(from, element)).isFile()) {
      fs.copyFileSync(path.join(from, element), path.join(to, element));
    } else {
      copyFolderSync(path.join(from, element), path.join(to, element));
    }
  });
}

// Copy scripts
const scriptsSrc = path.join(__dirname, 'scripts');
const scriptsDest = path.join(releaseDir, 'scripts');
if (fs.existsSync(scriptsSrc)) {
  copyFolderSync(scriptsSrc, scriptsDest);
}

// Copy .env.example
const envSrc = path.join(__dirname, '.env.example');
const envDest = path.join(releaseDir, '.env');
if (fs.existsSync(envSrc)) {
  fs.copyFileSync(envSrc, envDest);
}

console.log('5. Tạo các thư mục lưu trữ rỗng (data, profiles, .cache)...');
fs.mkdirSync(path.join(releaseDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'profiles'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, 'logs'), { recursive: true });
fs.mkdirSync(path.join(releaseDir, '.cache', 'puppeteer'), { recursive: true });

console.log('\n✅ Quá trình Build hoàn tất! Phiên bản chạy độc lập nằm trong thư mục: ToolProxy-Release');
