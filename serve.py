"""
CAD Map Navigator Dual HTTP & HTTPS Server
Serves HTTP (8080) and HTTPS (8443) concurrently for mobile GPS compatibility.
"""
import http.server
import socketserver
import socket
import ssl
import os
import sys
import threading

HTTP_PORT = 8080
HTTPS_PORT = 8443

def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, format, *args):
        # Clean logging
        super().log_message(format, *args)

def run_http(handler):
    try:
        with socketserver.TCPServer(("", HTTP_PORT), handler) as httpd:
            httpd.serve_forever()
    except Exception as e:
        print(f"HTTP Server Error: {e}")

def run_https(handler, cert_file, key_file):
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        with socketserver.TCPServer(("", HTTPS_PORT), handler) as httpsd:
            httpsd.socket = context.wrap_socket(httpsd.socket, server_side=True)
            httpsd.serve_forever()
    except Exception as e:
        print(f"HTTPS Server Error: {e}")

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    lan_ip = get_lan_ip()
    cert_path = os.path.join(script_dir, 'cert.pem')
    key_path = os.path.join(script_dir, 'key.pem')

    has_ssl = os.path.exists(cert_path) and os.path.exists(key_path)

    print("=" * 65)
    print(" 🚀 CAD Map Navigator 모바일 웹 서버 구동 중")
    print("=" * 65)
    print(f" [PC 브라우저 접속] : http://localhost:{HTTP_PORT}")
    print("-" * 65)
    print(f" [스마트폰 접속 주소 (일반)] : http://{lan_ip}:{HTTP_PORT}")
    if has_ssl:
        print(f" [스마트폰 접속 주소 (HTTPS 권장)] : https://{lan_ip}:{HTTPS_PORT}")
        print("  * 중요: 스마트폰 브라우저 보안 규정상 실제 GPS 센서를 켜려면")
        print("    HTTPS 주소(https://...)로 접속하셔야 GPS 위치 권한이 활성화됩니다.")
        print("    (사설 인증서 경고 화면이 뜨면 [고급] -> [계속 진행] 터치)")
    print("=" * 65)

    if has_ssl:
        t_https = threading.Thread(target=run_https, args=(CustomHandler, cert_path, key_path), daemon=True)
        t_https.start()

    try:
        run_http(CustomHandler)
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
        sys.exit(0)
