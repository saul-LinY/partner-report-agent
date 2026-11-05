import Foundation

/// Deployment configuration, not an editable end-user preference.
/// Set WEEKLY_REPORT_SERVICE_URL in project.yml when changing deployments.
enum AppConfiguration {
    static var serviceURL: URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "WeeklyReportServiceURL") as? String,
              !value.isEmpty, !value.hasPrefix("$("), let url = URL(string: value),
              (url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? ""))),
              url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    /// For a test server on the office network that has no publicly issued certificate: the SHA-256 of the one
    /// certificate it may present (WEEKLY_REPORT_PINNED_CERT_SHA256). Empty in normal builds. A value that is set but
    /// malformed is passed through on purpose: the connection then fails instead of silently falling back to no pin.
    static var pinnedCertificateSHA256: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "WeeklyReportPinnedCertSHA256") as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
    }
}
