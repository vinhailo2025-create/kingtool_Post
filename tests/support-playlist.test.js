const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PlaylistService = require('../src/services/support-playlist.service');

test('đọc danh sách video YouTube theo đúng thứ tự từ dữ liệu playlist', () => {
  const payload = {
    contents: [{
      lockupViewModel: {
        contentId: 'upamGjVXw20',
        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
        metadata: {
          lockupMetadataViewModel: { title: { content: 'SUPER POST KING' } },
        },
        contentImage: {
          thumbnailViewModel: {
            overlays: [{
              thumbnailBottomOverlayViewModel: {
                badges: [{ thumbnailBadgeViewModel: { text: '1:56' } }],
              },
            }],
          },
        },
      },
    }, {
      playlistVideoRenderer: {
        videoId: '52qwczXhMTk',
        title: { runs: [{ text: 'HƯỚNG DẪN SỬ DỤNG' }] },
        lengthText: { simpleText: '14:58' },
      },
    }],
  };
  const html = `<script>var ytInitialData = ${JSON.stringify(payload)};</script>`;
  const videos = PlaylistService.collectVideos(PlaylistService.parseInitialData(html));

  assert.deepEqual(videos, [
    { id: 'upamGjVXw20', title: 'SUPER POST KING', duration: '1:56' },
    { id: '52qwczXhMTk', title: 'HƯỚNG DẪN SỬ DỤNG', duration: '14:58' },
  ]);
});

test('sắp xếp video hướng dẫn theo quy trình sử dụng Super Post', () => {
  const titles = [
    'SUPER POST Agent: Điều Khiển Đăng Bài Facebook Bằng Điện Thoại',
    'Cài Đặt SUPER POST: API, Đường Dẫn, Delay Và Đồng Bộ Google Sheets',
    'Demo SUPER POST: Hướng dẫn thao tác đăng bài',
    'SUPER POST KING',
    'SUPER POST: Tự Động Bình Luận Facebook Sau Khi Đăng Bài',
    'SUPER POST AI: Viết Lại Nội Dung Hàng Loạt Và Tạo Ảnh Tự Động',
    'SUPER POST - HƯỚNG DẪN SỬ DỤNG',
    'Cấu Hình Bài Đăng SUPER POST: Số Lượng, Chống Bot, Delay Và Nhãn AI',
    'Kết Nối Trình Duyệt SUPER POST: Chrome Mới Hoặc Profile Anti-Detect',
    'Super Post King: Hướng Dẫn Cài Đặt Và Kích Hoạt Tool Từ A-Z',
  ];

  const sorted = PlaylistService.sortVideos(titles.map((title, index) => ({ id: index, title })));
  assert.deepEqual(sorted.map((video) => video.title), [
    'SUPER POST KING',
    'Kết Nối Trình Duyệt SUPER POST: Chrome Mới Hoặc Profile Anti-Detect',
    'SUPER POST - HƯỚNG DẪN SỬ DỤNG',
    'Demo SUPER POST: Hướng dẫn thao tác đăng bài',
    'Cấu Hình Bài Đăng SUPER POST: Số Lượng, Chống Bot, Delay Và Nhãn AI',
    'SUPER POST: Tự Động Bình Luận Facebook Sau Khi Đăng Bài',
    'SUPER POST AI: Viết Lại Nội Dung Hàng Loạt Và Tạo Ảnh Tự Động',
    'Cài Đặt SUPER POST: API, Đường Dẫn, Delay Và Đồng Bộ Google Sheets',
    'SUPER POST Agent: Điều Khiển Đăng Bài Facebook Bằng Điện Thoại',
    'Super Post King: Hướng Dẫn Cài Đặt Và Kích Hoạt Tool Từ A-Z',
  ]);
});

test('frontend tự tải playlist mới nhất và backend đã gắn route hỗ trợ', () => {
  const root = path.join(__dirname, '..');
  const settings = fs.readFileSync(path.join(root, 'public', 'js', 'settings.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(settings, /apiSilent\('\/api\/support\/youtube-playlist'\)/);
  assert.match(settings, /this\.guideVideos = normalizedVideos/);
  assert.match(server, /app\.use\('\/api\/support', require\('\.\/src\/routes\/support\.routes'\)\)/);
});
