import XCTest
import Security
@testable import WeeklyReportCore

final class CertificatePinTests: XCTestCase {
    /// A throwaway self-signed certificate (EC P-256, SAN 10.9.8.7). Its fingerprint is the one `openssl x509 -fingerprint -sha256` prints.
    private let certificateBase64 = "MIIBOjCB4aADAgECAhQTvhxa5FwQixYpTND/3TRyiO3nnjAKBggqhkjOPQQDAjATMREwDwYDVQQDDAhwaW4tdGVzdDAeFw0yNjExMDUwODMxMDdaFw0yNjEyMDUwODMxMDdaMBMxETAPBgNVBAMMCHBpbi10ZXN0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEq/HFrKiiE1VXytknZQFgl58aKDci4m8zPDIZ48sbFbb7JO7PpPsfslBho636xA+Q+J9KV6NF1uqViIaObBfohKMTMBEwDwYDVR0RBAgwBocECgkIBzAKBggqhkjOPQQDAgNIADBFAiEAs95hTEdWbEJvuNKn8gvzN+Q9GZu9CH184vZiniNxdc4CIFcEKFhzeb3zggENo6tNt2WJGCLSkpXDKCEPDzghEuSv"
    private let certificateFingerprint = "CB:94:61:43:F8:21:9C:02:43:0C:C9:C8:88:53:5A:A3:EA:00:F3:56:8F:D3:48:C3:BE:A2:AD:7B:41:67:C2:17"

    private func trust() throws -> SecTrust {
        let der = try XCTUnwrap(Data(base64Encoded: certificateBase64))
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, der as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        return try XCTUnwrap(trust)
    }

    func testFingerprintIsTheSHA256OfTheCertificateBytesInAnyWrittenForm() {
        XCTAssertEqual(CertificatePin.fingerprint(of: Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertTrue(CertificatePin.matches(Data("abc".utf8), pin: "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD"))
        XCTAssertTrue(CertificatePin.matches(Data("abc".utf8), pin: " ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n"))
        XCTAssertFalse(CertificatePin.matches(Data("abd".utf8), pin: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
    }

    func testAMalformedPinNeverMatchesSoABadConfigurationFailsClosed() {
        for pin in ["", "   ", "ba78", "not a fingerprint", String(repeating: "0", count: 63), String(repeating: "a", count: 65)] {
            XCTAssertFalse(CertificatePin.isWellFormed(pin), pin)
            XCTAssertFalse(CertificatePin.matches(Data("abc".utf8), pin: pin), pin)
        }
    }

    func testTheServerIsAcceptedOnlyWhenItPresentsExactlyThePinnedCertificate() throws {
        XCTAssertTrue(CertificatePin.accepts(try trust(), pin: certificateFingerprint))
        XCTAssertTrue(CertificatePin.accepts(try trust(), pin: certificateFingerprint.replacingOccurrences(of: ":", with: "").lowercased()))
        // Another certificate's fingerprint, an empty pin and a malformed pin all refuse it.
        XCTAssertFalse(CertificatePin.accepts(try trust(), pin: String(repeating: "ab", count: 32)))
        XCTAssertFalse(CertificatePin.accepts(try trust(), pin: ""))
        XCTAssertFalse(CertificatePin.accepts(try trust(), pin: "CB:94"))
    }
}
