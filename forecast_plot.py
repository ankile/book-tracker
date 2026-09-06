"""Plot a recorded simulation search without running models or accessing a database.

Run: python -m forecast_plot snapshots/forecast-joint/search.json
Requires matplotlib. Outputs PNG, SVG, PDF, and the plotted CSV beside the input.
"""

import argparse
import csv
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("search", type=Path)
    args = parser.parse_args()
    attempts = json.loads(args.search.read_text())["attempts"]
    scores = np.array([a["score"]["macro"] for a in attempts])
    draws = np.array([a["draws"] for a in attempts])
    assert len(attempts) and np.isfinite(scores).all()
    assert set(draws) <= {32, 128} and draws[0] == 128
    cohort = attempts[0]["score"]
    assert all(
        all(a["score"][k] == cohort[k] for k in ["books", "bookDays", "calendarDays"])
        for a in attempts
    ), "A frontier requires comparable evaluation cohorts"

    x = np.arange(1, len(attempts) + 1)
    frontier = np.minimum.accumulate(scores)
    confirmed = np.minimum.accumulate(np.where(draws == 128, scores, np.inf))
    best_index = int(np.argmin(np.where(draws == 128, scores, np.inf)))
    reduction = 100 * (1 - confirmed[-1] / scores[0])
    assert (np.diff(frontier) <= 0).all() and (np.diff(confirmed) <= 0).all()
    assert (frontier <= confirmed).all()

    base = args.search.parent / "experiment-frontier"
    with base.with_suffix(".csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow([
            "experiment", "draws", "mean_error_days", "best_so_far_days",
            "best_confirmed_days", "reason", "config",
        ])
        for i, a in enumerate(attempts):
            writer.writerow([
                i + 1, a["draws"], scores[i], frontier[i], confirmed[i],
                a["reason"], json.dumps(a["config"], sort_keys=True),
            ])

    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 11,
        "axes.spines.top": False, "axes.spines.right": False,
        "axes.edgecolor": "#A0A8AE", "text.color": "#202D38",
        "axes.labelcolor": "#202D38", "xtick.color": "#485662",
        "ytick.color": "#485662", "svg.fonttype": "none",
    })
    fig, ax = plt.subplots(figsize=(12, 7))
    fig.subplots_adjust(left=.095, right=.975, top=.80, bottom=.29)
    fig.text(.095, .94, "Reading forecast experiments", fontsize=21, weight="bold")
    fig.text(.095, .891,
             f"Best confirmed mean error: {scores[0]:.2f} → {confirmed[-1]:.2f} days"
             f"   ·   {reduction:.1f}% lower", fontsize=14)
    fig.text(.095, .85,
             f"{len(attempts)} evaluations · "
             f"{len({a['key'] for a in attempts})} configurations · "
             "development cohort before 2024", color="#566571")

    for count, marker, color, label in [
        (32, "o", "#91A8BC", "Screening · 32 simulated futures"),
        (128, "D", "#235A83", "Confirmation · 128 simulated futures"),
    ]:
        mask = draws == count
        ax.scatter(x[mask], scores[mask], marker=marker, s=27 if count == 32 else 32,
                   color=color, edgecolors="white", linewidths=.45, label=label, zorder=3)
    ax.step(x, frontier, where="post", color="#D17A00", linewidth=2,
            label="Best so far · any evaluation", zorder=4)
    ax.step(x, confirmed, where="post", color="#007E78", linewidth=2.2,
            linestyle=(0, (4, 3)), label="Best so far · confirmed", zorder=5)

    ax.annotate(f"Best confirmed\n#{best_index + 1} · {confirmed[-1]:.3f} days",
                xy=(best_index + 1, confirmed[-1]), xytext=(-9, 59),
                textcoords="offset points", ha="center", fontsize=11,
                color="#00675F", bbox={"facecolor": "white", "edgecolor": "none", "pad": 4},
                arrowprops={"arrowstyle": "-", "color": "#007E78", "linewidth": 1.2},
                zorder=7)
    ax.set_xlim(0, len(attempts) + 3)
    ax.set_ylim(float(scores.min()) - .35, float(scores.max()) + .4)
    ax.set_xlabel("Experiment number, in recorded execution order", labelpad=12)
    ax.set_ylabel("Mean absolute error, days ↓", labelpad=12)
    ax.set_xticks([1, *range(20, len(attempts), 20), len(attempts)])
    ax.grid(axis="y", color="#E1E6EA", linewidth=.7, zorder=0)
    fig.legend(*ax.get_legend_handles_labels(), loc="lower left",
               bbox_to_anchor=(.084, .104), ncol=2, frameon=False,
               columnspacing=2.5, handlelength=3)
    fig.text(.095, .069,
             f"Each book has equal weight: {cohort['books']} books, "
             f"{cohort['bookDays']:,} daily predictions. Error uses a 90-day capped horizon.",
             fontsize=10, color="#566571")
    fig.text(.095, .039,
             "Lines show the running minimum. This is tuning progress, not an estimate of unseen-book accuracy.",
             fontsize=10, color="#566571")
    for extension in ["png", "svg", "pdf"]:
        fig.savefig(base.with_suffix("." + extension), dpi=180, facecolor="white")
    plt.close(fig)
    print(json.dumps({
        "evaluations": len(attempts), "best_confirmed_experiment": best_index + 1,
        "best_confirmed_mean_error_days": float(confirmed[-1]),
        "improvement_percent": reduction, "output": str(base),
    }, indent=2))


if __name__ == "__main__":
    main()
