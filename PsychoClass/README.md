# PsychoClass 2.2 · Calm response edition

Khảo sát cảm xúc học đường với giao diện nhẹ nhàng, phản hồi từng câu, tổng kết cá nhân và báo cáo Discord theo lựa chọn đồng ý của người tham gia.

## Có gì mới trong bản này

- Sau câu thứ 10, người dùng nhận được lời nhắn mở đầu ngay lập tức. Phần tổng kết cá nhân tiếp tục được hoàn thiện và tự cập nhật khi sẵn sàng.
- Báo cáo Discord được gửi ở nền sau khi có phần tổng kết, không bắt người tham gia chờ thao tác gửi tệp hoàn tất. Trạng thái gửi được cập nhật riêng.
- Phần tổng kết được rút gọn, chỉ đọc nội dung cần thiết, giới hạn độ dài đầu ra để giảm thời gian phản hồi.
- Hỗ trợ nhóm nhiều Groq API key: luân phiên khóa giữa các yêu cầu, tạm ngưng khóa lỗi và thử khóa dự phòng trong giới hạn thời gian. Khóa lỗi xác thực được tạm ngưng lâu hơn; giới hạn tốc độ được ghi nhận để tránh tiếp tục gọi liên tục.
- Giao diện hướng tới sự bình tĩnh và an toàn cảm xúc; người tham gia không thấy thông tin kỹ thuật.
- Vẫn giữ đủ 10 câu; bắt buộc câu TXT số 1 và 2, chọn thêm ngẫu nhiên để có 3–5 câu TXT và 5–7 câu AI.
- Biệt danh/tuổi không bắt buộc. Báo cáo Discord chỉ được gửi khi người tham gia chủ động đồng ý.

## Yêu cầu

- Node.js 20 trở lên.
- Một hoặc nhiều Groq API key mà bạn được phép quản lý, có quyền sử dụng mô hình đã cấu hình.
- Một Discord webhook mới nếu muốn nhận báo cáo tự động.

## Khởi chạy trên Windows

1. Giải nén thư mục `PsychoClass`.
2. Mở Command Prompt/Terminal tại thư mục đó.
3. Tạo tệp cấu hình riêng:

   ```bat
   copy .env.example .env
   notepad .env
   ```

4. Điền khóa AI vào `.env`. Định dạng dễ nhất là danh sách phân cách bằng dấu phẩy:

   ```dotenv
   GROQ_API_KEYS=GROQ_KEY_1,GROQ_KEY_2,GROQ_KEY_3
   GROQ_MODEL=llama-3.3-70b-versatile
   DISCORD_WEBHOOK_URL=YOUR_NEW_DISCORD_WEBHOOK_URL
   PORT=3000
   ```

   Có thể thay `GROQ_API_KEYS` bằng các biến `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, `GROQ_API_KEY_3`. Bản mới vẫn hỗ trợ biến đơn `GROQ_API_KEY` cho cấu hình cũ. Đừng để nguyên chuỗi `PASTE_...` trong tệp cấu hình.

5. Chạy ứng dụng:

   ```bat
   npm start
   ```

6. Mở `http://localhost:3000`.

## Luân phiên nhiều khóa

- Khóa được luân phiên giữa các yêu cầu. Nếu một khóa gặp lỗi tạm thời, giới hạn tốc độ hoặc lỗi xác thực, hệ thống có thể chuyển sang khóa dự phòng còn hoạt động; khóa lỗi được tạm ngưng trong một khoảng thời gian.
- Nhiều API key thuộc cùng một tài khoản/tổ chức có thể vẫn dùng chung hạn mức. Không dùng nhóm khóa để né hạn mức cấp tài khoản hoặc giới hạn sử dụng của nhà cung cấp; dùng khóa dự phòng hợp lệ và tuân thủ hạn mức áp dụng.
- Khóa API không được đưa vào HTML, chia sẻ công khai hay commit lên kho mã nguồn. Nếu nghi ngờ khóa bị lộ, hãy thu hồi và tạo khóa mới.

## Chỉnh bộ câu hỏi TXT

Chỉnh `data/cau-hoi.txt`. Mỗi câu cần bắt đầu bằng số, ví dụ `1. Nội dung câu hỏi?`. Tệp cần có ít nhất ba câu đánh số và luôn phải chứa câu 1 và 2.

## Discord và riêng tư

- Chỉ điền webhook mới trong `.env`. Tệp HTML cũ trong gói gốc đã có webhook trực tiếp; hãy thu hồi webhook cũ và tạo webhook mới trước khi dùng bản nâng cấp.
- Báo cáo có thể chứa nội dung riêng tư. Chỉ gửi đến kênh Discord có quyền truy cập phù hợp. Người tham gia cần được thông báo rõ nội dung nào sẽ được gửi.
- Nếu người tham gia không đồng ý, báo cáo không được chuyển sang Discord. Họ vẫn có thể tải hoặc sao chép kết quả trong trình duyệt.
- Bản tổng kết nhanh được hiển thị trước để người tham gia không phải nhìn màn hình chờ. Khi AI hoàn thiện phản hồi cá nhân, nội dung sẽ tự cập nhật; nếu AI tạm thời không sẵn sàng, lời nhắn mở đầu vẫn hiển thị.

## Lưu ý

Đây là công cụ tự suy ngẫm, không phải công cụ chẩn đoán hay thay thế chuyên gia tâm lý. AI có thể hiểu sai ngữ cảnh; người dùng nên giữ lại những gợi ý thấy hữu ích và bỏ qua điều không phù hợp. Không nhập mật khẩu hoặc thông tin nhận dạng nhạy cảm. Nếu triển khai ra Internet, hãy dùng HTTPS, kiểm soát quyền truy cập, giới hạn chi phí và cân nhắc bổ sung chống lạm dụng trước khi mời người khác sử dụng.
