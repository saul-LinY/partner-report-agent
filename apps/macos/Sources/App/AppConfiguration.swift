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
}
