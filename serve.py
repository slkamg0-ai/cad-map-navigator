"""
CAD Map Navigator Dual HTTP & HTTPS Server
Serves HTTP (8080) and HTTPS (8443) concurrently for PC & mobile GPS compatibility.
"""
import http.server
import socketserver
import socket
import ssl
import os
import sys
import threading
import webbrowser

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

class ReusableThreadingTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.wasm': 'application/wasm',
        '.dxf': 'text/plain; charset=utf-8',
        '.json': 'application/json',
    }

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, format, *args):
        super().log_message(format, *args)

def run_http(handler):
    try:
        with ReusableThreadingTCPServer(("", HTTP_PORT), handler) as httpd:
            httpd.serve_forever()
    except Exception as e:
        print(f"HTTP Server Error: {e}", flush=True)

def run_https(handler, cert_file, key_file):
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        with ReusableThreadingTCPServer(("", HTTPS_PORT), handler) as httpsd:
            httpsd.socket = context.wrap_socket(httpsd.socket, server_side=True)
            httpsd.serve_forever()
    except Exception as e:
        print(f"HTTPS Server Error: {e}", flush=True)

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    lan_ip = get_lan_ip()
    cert_path = os.path.join(script_dir, 'cert.pem')
    key_path = os.path.join(script_dir, 'key.pem')

    has_ssl = os.path.exists(cert_path) and os.path.exists(key_path)

    print("=" * 65, flush=True)
    print(" [CAD Map Navigator - Dual Mode Server Running]", flush=True)
    print("=" * 65, flush=True)
    print(f" [PC Browser URL]     : http://localhost:{HTTP_PORT}", flush=True)
    print("-" * 65, flush=True)
    print(f" [Mobile HTTP URL]    : http://{lan_ip}:{HTTP_PORT}", flush=True)
    if has_ssl:
        print(f" [Mobile HTTPS (GPS)] : https://{lan_ip}:{HTTPS_PORT}", flush=True)
    print("=" * 65, flush=True)

    if has_ssl:
        t_https = threading.Thread(target=run_https, args=(CustomHandler, cert_path, key_path), daemon=True)
        t_https.start()

    # Automatically open the browser after 0.8s
    threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{HTTP_PORT}")).start()

    try:
        run_http(CustomHandler)
    except KeyboardInterrupt:
        print("\nServer stopped.", flush=True)
        sys.exit(0)
