# Cổng MCP an toàn cho MIDAS Civil

Cổng này cho phép mọi MCP client tạo và kiểm tra mô hình MCT cho **MIDAS Civil 2022**. Bản Civil 2022 không có Open API như CIVIL NX, vì vậy đường tích hợp ổn định là file/MCT Command Shell. Cổng không can thiệp đăng nhập, giấy phép hoặc cơ chế bảo vệ phần mềm.

## Cơ chế an toàn

1. `midas_preview_beam` chỉ dựng MCT trong bộ nhớ, kiểm tra liên kết node–element–material–section và trả SHA-256.
2. `midas_commit_beam` chỉ ghi khi AI gửi lại đúng tham số và đúng SHA-256 của bản xem trước.
3. `midas_preview_revit_bridge` chuyển tệp xương hình học đã xuất từ Revit thành mô hình MIDAS có dầm hộp PSC rỗng, biến chiều cao theo từng mét trong bộ nhớ.
4. `midas_commit_revit_bridge` chỉ ghi khi cả SHA-256 của dữ liệu Revit và SHA-256 của MCT đều còn khớp.
5. File có sẵn không bị ghi đè nếu chưa cung cấp cả `overwrite=true` và SHA-256 hiện tại của file.
6. Chỉ các lệnh MCT thuộc danh sách an toàn cho mô hình khung được chấp nhận. Không tự chạy phân tích và không đưa kết luận kỹ thuật.
7. Điều khiển giao diện cũng tách hai bước: `midas_ui_stage_mct` chỉ đặt mã vào cửa sổ; `midas_ui_run_staged` kiểm tra lại PID, tiêu đề cửa sổ và SHA-256 trước khi bấm **Run**.

## Chạy máy chủ

```powershell
git clone https://github.com/duy232633786-dot/midas-civil-mcp.git
cd midas-civil-mcp
npm install
$env:MIDAS_WORKDIR="$HOME\MIDAS-MCP-Work"
npm start
```

Mẫu cấu hình chung cho một MCP client:

```json
{
  "midas-civil": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["C:\\path\\to\\midas-civil-mcp\\server.js"],
    "env": {
      "MIDAS_EXE": "C:\\Program Files\\MIDAS\\midas Civil\\CVLw.exe",
      "MIDAS_WORKDIR": "C:\\path\\to\\MIDAS-MCP-Work"
    }
  }
}
```

Mỗi ứng dụng AI đặt khối `command`, `args`, `env` vào vị trí cấu hình MCP riêng của ứng dụng đó.

## Nạp mô hình vào MIDAS Civil 2022

Với bản xem trước không khai báo `mctVersion`, dùng quy trình tương thích nhất:

1. Tạo một mô hình mới, trống trong MIDAS.
2. Mở **Tools > MCT Command Shell**.
3. Dùng `midas_prepare_command_shell` để lấy nội dung đã kiểm tra.
4. Dán nội dung, kiểm tra bằng mắt và bấm **Run** trong mô hình trống.

AI có thể làm bước 3–4 trực tiếp bằng `midas_ui_stage_mct` rồi `midas_ui_run_staged`. Công cụ Run chỉ hoạt động với nội dung vừa được chính máy chủ đặt vào cửa sổ và đòi hỏi xác nhận rằng mô hình đích được phép thay đổi, không có dữ liệu chưa lưu cần giữ. Nếu MIDAS đang mở một mô hình có giá trị, hãy lưu/đóng mô hình đó hoặc mở một phiên được cấp phép riêng trước.

Trong chế độ Command Shell, nội dung không chứa `*ENDDATA`; lệnh này chỉ được thêm khi có `mctVersion` và dùng file-import mode. Đây là khác biệt đã được kiểm chứng trực tiếp trên Civil 2022.

Nếu biết chính xác phiên bản MCT tương thích, điền `mctVersion` khi xem trước; khi đó file có thể dùng cho chế độ import. Không lấy số phiên bản sản phẩm để đoán số phiên bản MCT.

## Chuyển cầu Revit sang MIDAS

1. Chạy `scripts/ExportRevitBridgeSkeleton.csx` qua Revit MCP để đọc family, transform và các điểm thích ứng. Script chỉ xuất JSON, không sửa cấu kiện Revit.
2. Đặt JSON trong `MIDAS_WORKDIR` rồi gọi `midas_preview_revit_bridge`.
3. Dùng cả `sourceSha256` và `sha256` nhận được để gọi `midas_commit_revit_bridge`.
4. Nạp MCT bằng quy trình Stage → Run ở trên trong một mô hình MIDAS trống.

Bộ ánh xạ hiện hỗ trợ dầm hộp PSC rỗng rộng 12 m với chiều cao biến thiên parabol 10,5→3,5 m, chia phần tử 1 m theo bốn cánh hẫng; đồng thời giữ vòm–dàn thích ứng, tháp/trụ, dây văng, mố, đài và cọc. Asphalt, lan can, đèn, vạch sơn và các chi tiết không phục vụ mô hình phân tích được loại bỏ. Vật liệu, liên kết, cáp dự ứng lực, giai đoạn thi công, tải trọng và điều kiện biên vẫn là giả định khởi tạo, bắt buộc kỹ sư cầu kiểm tra trước khi phân tích.

## Công cụ MCP

- `midas_inspect_installation`: kiểm tra cài đặt ở chế độ chỉ đọc.
- `midas_preview_beam`: xem trước dầm và nhận SHA-256.
- `midas_commit_beam`: ghi đúng bản đã xem trước.
- `midas_preview_revit_bridge`: xem trước mô hình cầu phân tích từ JSON Revit, không ghi tệp.
- `midas_commit_revit_bridge`: ghi đúng MCT cầu đã xem trước với khóa kép nguồn–đầu ra.
- `midas_validate_mct`: kiểm tra MCT mà không ghi/chạy.
- `midas_list_files`, `midas_read_file`: xem workspace giới hạn.
- `midas_prepare_command_shell`: chuẩn bị nội dung và hướng dẫn nạp.
- `midas_ui_inspect`: liệt kê đúng PID và tiêu đề các cửa sổ MIDAS.
- `midas_ui_stage_mct`: đặt MCT đã xác minh vào Command Shell nhưng không bấm Run.
- `midas_ui_run_staged`: bấm Run sau lần xác nhận riêng và kiểm tra lại đích/nội dung.
- `midas_ui_close_command_shell`: đóng Command Shell mà không chạy.
- `midas_open`, `midas_open_mct`: mở MIDAS theo yêu cầu rõ ràng.
- `midas_nx_status`: kiểm tra cấu hình REST cho CIVIL NX mà không làm lộ MAPI-Key.

Tài liệu chính thức: [MCT Command Shell](https://support.midasuser.com/hc/en-us/articles/18561873323289-MCT-Command-Shell), [MCT Command List](https://support.midasuser.com/hc/en-us/articles/18575109934489-MCT-Command-List), [MIDAS API Online Manual](https://support.midasuser.com/hc/en-us/articles/33016922742937-MIDAS-API-Online-Manual).

Các file mô hình, ảnh chụp và báo cáo kiểm chứng chạy thật trên máy của tác giả không được đưa vào repo công khai. Để dựng MCT từ một khung xương Revit: `node build-revit-bridge.js <skeleton.json> [output.mct]`.

## Giấy phép

MIT — xem `LICENSE`. MIDAS Civil là phần mềm thương mại của MIDAS IT; repo này không kèm phần mềm, giấy phép hay dữ liệu của MIDAS và không can thiệp cơ chế bảo vệ bản quyền.
