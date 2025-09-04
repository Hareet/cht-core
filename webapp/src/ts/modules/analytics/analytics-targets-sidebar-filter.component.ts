import { Component, EventEmitter, Input, OnDestroy, OnInit, OnChanges, Output, ChangeDetectorRef } from '@angular/core';
import { Store } from '@ngrx/store';
import { Subscription } from 'rxjs';
import { NgClass, NgIf, NgFor } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIcon } from '@angular/material/icon';
import { MatAccordion } from '@angular/material/expansion';
import { TranslatePipe } from '@ngx-translate/core';
import { GlobalActions } from '@mm-actions/global';
import { Selectors } from '@mm-selectors/index';
import { ReportingPeriod } from './analytics-target-aggregates-sidebar-filter.component';

interface SidebarFilterState {
  readonly isOpen: boolean;
  readonly defaultFilters?: {
    readonly reportingPeriod: ReportingPeriod;
  };
}

interface ReportingPeriodOption {
  readonly value: ReportingPeriod;
  readonly label: string;
  monthDisplay?: string;
}

@Component({
  selector: 'mm-analytics-targets-sidebar-filter',
  templateUrl: './analytics-targets-sidebar-filter.component.html',
  imports: [NgClass, NgIf, MatIcon, MatAccordion, NgFor, FormsModule, TranslatePipe]
})
export class AnalyticsTargetsSidebarFilterComponent implements OnInit, OnChanges, OnDestroy {
  private readonly subscriptions = new Subscription();
  private globalActions;
  
  @Input() currentMonthDisplay = '';
  @Input() previousMonthDisplay = '';
  @Input() currentPeriod: ReportingPeriod = ReportingPeriod.CURRENT;  // Inputs or the same export enum we see in aggreg?
  @Output() readonly reportingPeriodSelectionChanged = new EventEmitter<ReportingPeriod>();
  
  isOpen = false;
  sidebarFilter?: SidebarFilterState;
  selectedReportingPeriod: ReportingPeriod = ReportingPeriod.CURRENT;
  
  get reportingPeriods(): ReadonlyArray<ReportingPeriodOption> {
    return [
      { 
        value: ReportingPeriod.CURRENT, 
        label: 'targets.this_month.subtitle',
        monthDisplay: this.currentMonthDisplay || 'Current Month'
      },
      { 
        value: ReportingPeriod.PREVIOUS, 
        label: 'targets.last_month.subtitle',
        monthDisplay: this.previousMonthDisplay || 'Previous Month'
      }
    ] as const;
  }
  
  constructor(
    private readonly store: Store,
    private readonly cdr: ChangeDetectorRef
  ) {
    this.globalActions = new GlobalActions(store);
    
    // Do we have to subscribe to store here for initial sync? Try to remove this for subscribeToStore
    this.store.select(Selectors.getSidebarFilter).subscribe(state => {
      if (state && state.hasOwnProperty('isOpen')) {
        this.isOpen = !!state.isOpen; 
      }
    });
  }
  
  ngOnInit() {
    this.subscribeToStore();
    this.selectedReportingPeriod = this.currentPeriod || ReportingPeriod.CURRENT;
  }
  
  ngOnChanges(changes: any) {
    if (changes.currentPeriod && changes.currentPeriod.currentValue !== undefined) {
      this.selectedReportingPeriod = changes.currentPeriod.currentValue;
      this.cdr.detectChanges();
    }
  }
  
  ngOnDestroy() {
    this.subscriptions.unsubscribe();
  }
  
  private subscribeToStore() {
    const subscription = this.store
      .select(Selectors.getSidebarFilter)
      .subscribe((sidebarFilter: SidebarFilterState) => {
        this.sidebarFilter = sidebarFilter;
        if (sidebarFilter && sidebarFilter.hasOwnProperty('isOpen')) {
          this.isOpen = !!sidebarFilter.isOpen;
          this.cdr.detectChanges();  // Ask if there's something else I could do here?
        }
      });
    this.subscriptions.add(subscription);
  }
  
  toggleSidebarFilter() {
    this.isOpen = !this.isOpen;
    this.globalActions.setSidebarFilter({ isOpen: this.isOpen });
  };
  
  fetchTargetsByReportingPeriod() {
    try {
      this.reportingPeriodSelectionChanged.emit(this.selectedReportingPeriod);
    } catch (error: unknown) {
      console.error('Error emitting period change:', error);
    }
  }
  
  trackByValue = (_index: number, period: ReportingPeriodOption): string => {
    return period.value;
  };
}