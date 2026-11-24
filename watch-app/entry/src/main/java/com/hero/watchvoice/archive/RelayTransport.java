package com.hero.watchvoice.archive;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import ohos.net.NetHandle;
import ohos.utils.zson.ZSONArray;
import ohos.utils.zson.ZSONObject;

final class RelayTransport {
    private static final int MAX_REPLY = 8192;
    private static String cachedAddress = RelaySettings.IPV4_BACKUP;

    static Reply request(NetHandle network, URL url, File audio, boolean retry) throws IOException {
        String host = url.getHost();
        if (!"https".equals(url.getProtocol()) || !host.matches("[a-zA-Z0-9.-]+")
                || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)) {
            throw new IOException("Invalid relay HTTPS address");
        }
        if (!cachedAddress.isEmpty()) {
            try {
                return exchange(network, cachedAddress, host, url.getFile(), audio, retry, true);
            } catch (IOException error) {
                cachedAddress = "";
            }
        }
        Reply dns = exchange(network, "1.1.1.1", "cloudflare-dns.com",
                "/dns-query?type=A&name=" + host, null, false, false);
        ZSONObject result = dns.status == 200 ? ZSONObject.stringToZSON(dns.body) : null;
        ZSONArray answers = result == null ? null : result.getZSONArray("Answer");
        if (answers != null) {
            for (int index = 0; index < answers.size(); index++) {
                ZSONObject answer = answers.getZSONObject(index);
                if (answer == null || answer.getIntValue("type") != 1) continue;
                String address = answer.getString("data");
                if (address == null || !address.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) continue;
                try {
                    Reply response = exchange(network, address, host, url.getFile(), audio, retry, true);
                    cachedAddress = address;
                    return response;
                } catch (IOException ignored) {
                    // Try the next authenticated answer while keeping the relay hostname for TLS.
                }
            }
        }
        throw new IOException("No usable relay address from secure DNS");
    }

    private static Reply exchange(NetHandle network, String address, String host, String path,
                                  File audio, boolean retry, boolean relay) throws IOException {
        try (Socket underlying = network == null ? new Socket() : network.getSocketFactory().createSocket()) {
            underlying.connect(new InetSocketAddress(address, 443), 10000);
            underlying.setSoTimeout(20000);
            try (SSLSocket tls = (SSLSocket) HttpsURLConnection.getDefaultSSLSocketFactory()
                    .createSocket(underlying, host, 443, true)) {
                SSLParameters parameters = tls.getSSLParameters();
                parameters.setEndpointIdentificationAlgorithm("HTTPS");
                parameters.setServerNames(Collections.singletonList(new SNIHostName(host)));
                tls.setSSLParameters(parameters);
                tls.startHandshake();

                OutputStream output = tls.getOutputStream();
                String headers = (audio == null ? "GET " : "PUT ") + path
                        + " HTTP/1.1\r\nHost: " + host + "\r\nConnection: close\r\n";
                headers += relay ? "Authorization: Bearer " + RelaySettings.TOKEN + "\r\n" : "Accept: application/dns-json\r\n";
                if (audio != null) {
                    headers += "Content-Type: audio/mp4\r\nContent-Length: " + audio.length() + "\r\n";
                    if (retry) headers += "X-Archive-Retry: 1\r\n";
                }
                output.write((headers + "\r\n").getBytes(StandardCharsets.US_ASCII));
                if (audio != null) {
                    try (InputStream recording = new FileInputStream(audio)) {
                        byte[] buffer = new byte[8192];
                        for (int size; (size = recording.read(buffer)) != -1;) output.write(buffer, 0, size);
                    }
                }
                output.flush();
                return readReply(new BufferedInputStream(tls.getInputStream()));
            }
        }
    }

    private static Reply readReply(InputStream input) throws IOException {
        String[] status = line(input).split(" ", 3);
        if (status.length < 2 || !status[0].startsWith("HTTP/1.")) throw new IOException("Missing HTTP response");
        int code = Integer.parseInt(status[1]);
        boolean chunked = false;
        int length = -1;
        int headerCount = 0;
        for (String header; !(header = line(input)).isEmpty();) {
            if (++headerCount > 80) throw new IOException("Too many reply headers");
            String field = header.toLowerCase(Locale.ROOT);
            if (field.startsWith("transfer-encoding:")) chunked = field.contains("chunked");
            if (field.startsWith("content-length:")) length = Integer.parseInt(field.substring(15).trim());
        }
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        if (chunked) {
            for (;;) {
                int size = Integer.parseInt(line(input).split(";", 2)[0].trim(), 16);
                if (size == 0) break;
                copy(input, body, size);
                if (!line(input).isEmpty()) throw new IOException("Invalid chunk delimiter");
            }
        } else if (length >= 0) {
            copy(input, body, length);
        } else {
            for (int next; (next = input.read()) >= 0;) {
                if (body.size() >= MAX_REPLY) throw new IOException("Reply too large");
                body.write(next);
            }
        }
        return new Reply(code, new String(body.toByteArray(), StandardCharsets.UTF_8));
    }

    private static String line(InputStream input) throws IOException {
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        for (int next; (next = input.read()) >= 0;) {
            if (next == '\n') return new String(text.toByteArray(), StandardCharsets.US_ASCII).trim();
            if (text.size() >= MAX_REPLY) throw new IOException("Header too large");
            text.write(next);
        }
        throw new IOException("Incomplete response header");
    }

    private static void copy(InputStream input, ByteArrayOutputStream output, int size) throws IOException {
        if (size < 0 || size > MAX_REPLY - output.size()) throw new IOException("Reply too large");
        byte[] buffer = new byte[Math.min(1024, size)];
        while (size > 0) {
            int read = input.read(buffer, 0, Math.min(buffer.length, size));
            if (read < 0) throw new IOException("Incomplete response body");
            output.write(buffer, 0, read);
            size -= read;
        }
    }

    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }
}
