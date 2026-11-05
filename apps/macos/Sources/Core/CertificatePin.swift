import CryptoKit
import Foundation
import Security

/// Trust for a server that has no publicly issued certificate (a team's own test server on the office network):
/// the one certificate the build was made for. Nothing is installed on the Mac, and any other certificate is refused.
public enum CertificatePin {
    /// Lowercase hex without separators, so `AB:CD:…` from `openssl x509 -fingerprint` and plain hex compare equal.
    public static func normalized(_ fingerprint: String) -> String {
        fingerprint.lowercased().filter(\.isHexDigit)
    }

    /// A SHA-256 fingerprint is 64 hex digits; anything else can never match.
    public static func isWellFormed(_ fingerprint: String) -> Bool { normalized(fingerprint).count == 64 }

    public static func fingerprint(of certificateDER: Data) -> String {
        SHA256.hash(data: certificateDER).map { String(format: "%02x", $0) }.joined()
    }

    public static func matches(_ certificateDER: Data, pin: String) -> Bool {
        isWellFormed(pin) && fingerprint(of: certificateDER) == normalized(pin)
    }

    /// True only when the server's own (leaf) certificate is exactly the pinned one.
    static func accepts(_ trust: SecTrust, pin: String) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return false }
        return matches(SecCertificateCopyData(leaf) as Data, pin: pin)
    }
}
