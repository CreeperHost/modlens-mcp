export function compactNotices(notices: Array<{ name: string; licenseText: string }>): Array<{ name: string; licenseText: string }> {
    const grouped = new Map<string, Set<string>>();
    for (const notice of notices) {
        const names = grouped.get(notice.licenseText) ?? new Set<string>();
        names.add(notice.name);
        grouped.set(notice.licenseText, names);
    }
    return [...grouped].map(([licenseText, names]) => ({ name: [...names].join(", "), licenseText }));
}
