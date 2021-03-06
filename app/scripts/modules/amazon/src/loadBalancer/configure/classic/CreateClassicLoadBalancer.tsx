import * as React from 'react';
import { cloneDeep, get } from 'lodash';
import { BindAll } from 'lodash-decorators';
import { FormikErrors, FormikValues } from 'formik';
import { IDeferred, IPromise } from 'angular';
import { IModalServiceInstance } from 'angular-ui-bootstrap';
import { $q } from 'ngimport';

import { ILoadBalancerModalProps, ReactInjector, TaskMonitor, WizardModal } from '@spinnaker/core';

import { AWSProviderSettings } from 'amazon/aws.settings';
import { IAmazonClassicLoadBalancer, IAmazonClassicLoadBalancerUpsertCommand } from 'amazon/domain';
import { AwsReactInjector } from 'amazon/reactShims';

import { AdvancedSettings } from './AdvancedSettings';
import { HealthCheck } from './HealthCheck';
import { Listeners } from './Listeners';
import { SecurityGroups } from '../common/SecurityGroups';
import { LoadBalancerLocation } from '../common/LoadBalancerLocation';

import '../common/configure.less';

export interface ICreateClassicLoadBalancerProps extends ILoadBalancerModalProps {
  loadBalancer: IAmazonClassicLoadBalancer;
}

export interface ICreateClassicLoadBalancerState {
  includeSecurityGroups: boolean;
  isNew: boolean;
  loadBalancerCommand: IAmazonClassicLoadBalancerUpsertCommand;
  taskMonitor: TaskMonitor;
}

type ClassicLoadBalancerModal = new () => WizardModal<IAmazonClassicLoadBalancerUpsertCommand>;
const ClassicLoadBalancerModal = WizardModal as ClassicLoadBalancerModal;

@BindAll()
export class CreateClassicLoadBalancer extends React.Component<
  ICreateClassicLoadBalancerProps,
  ICreateClassicLoadBalancerState
> {
  private refreshUnsubscribe: () => void;
  private certificateTypes = get(AWSProviderSettings, 'loadBalancers.certificateTypes', ['iam', 'acm']);
  private $uibModalInstanceEmulation: IModalServiceInstance & { deferred?: IDeferred<any> };

  constructor(props: ICreateClassicLoadBalancerProps) {
    super(props);

    const loadBalancerCommand = props.loadBalancer
      ? AwsReactInjector.awsLoadBalancerTransformer.convertClassicLoadBalancerForEditing(props.loadBalancer)
      : AwsReactInjector.awsLoadBalancerTransformer.constructNewClassicLoadBalancerTemplate(props.app);

    this.state = {
      includeSecurityGroups: !!loadBalancerCommand.vpcId,
      isNew: !props.loadBalancer,
      loadBalancerCommand,
      taskMonitor: null,
    };

    const deferred = $q.defer();
    const promise = deferred.promise;
    this.$uibModalInstanceEmulation = {
      result: promise,
      close: () => this.props.showCallback(false),
      dismiss: () => this.props.showCallback(false),
    } as IModalServiceInstance;
    Object.assign(this.$uibModalInstanceEmulation, { deferred });
  }

  private dismiss(): void {
    this.props.showCallback(false);
  }

  protected certificateIdAsARN(
    accountId: string,
    certificateId: string,
    region: string,
    certificateType: string,
  ): string {
    if (
      certificateId &&
      (certificateId.indexOf('arn:aws:iam::') !== 0 || certificateId.indexOf('arn:aws:acm:') !== 0)
    ) {
      // If they really want to enter the ARN...
      if (certificateType === 'iam') {
        return `arn:aws:iam::${accountId}:server-certificate/${certificateId}`;
      }
      if (certificateType === 'acm') {
        return `arn:aws:acm:${region}:${accountId}:certificate/${certificateId}`;
      }
    }
    return certificateId;
  }

  protected formatListeners(command: IAmazonClassicLoadBalancerUpsertCommand): IPromise<void> {
    return ReactInjector.accountService.getAccountDetails(command.credentials).then(account => {
      command.listeners.forEach(listener => {
        listener.sslCertificateId = this.certificateIdAsARN(
          account.accountId,
          listener.sslCertificateName,
          command.region,
          listener.sslCertificateType || this.certificateTypes[0],
        );
      });
    });
  }

  private clearSecurityGroupsIfNotInVpc(loadBalancer: IAmazonClassicLoadBalancerUpsertCommand): void {
    if (!loadBalancer.vpcId && !loadBalancer.subnetType) {
      loadBalancer.securityGroups = null;
    }
  }

  private addHealthCheckToCommand(loadBalancer: IAmazonClassicLoadBalancerUpsertCommand): void {
    let healthCheck = null;
    const protocol = loadBalancer.healthCheckProtocol || '';
    if (protocol.startsWith('HTTP')) {
      healthCheck = `${protocol}:${loadBalancer.healthCheckPort}${loadBalancer.healthCheckPath}`;
    } else {
      healthCheck = `${protocol}:${loadBalancer.healthCheckPort}`;
    }
    loadBalancer.healthCheck = healthCheck;
  }

  public setAvailabilityZones(loadBalancerCommand: IAmazonClassicLoadBalancerUpsertCommand): void {
    const availabilityZones: { [region: string]: string[] } = {};
    availabilityZones[loadBalancerCommand.region] = loadBalancerCommand.regionZones || [];
    loadBalancerCommand.availabilityZones = availabilityZones;
  }

  protected formatCommand(command: IAmazonClassicLoadBalancerUpsertCommand): void {
    this.setAvailabilityZones(command);
    this.clearSecurityGroupsIfNotInVpc(command);
    this.addHealthCheckToCommand(command);
  }

  protected onApplicationRefresh(values: IAmazonClassicLoadBalancerUpsertCommand): void {
    this.refreshUnsubscribe = undefined;
    this.props.showCallback(false);
    this.setState({ taskMonitor: undefined });
    const newStateParams = {
      name: values.name,
      accountId: values.credentials,
      region: values.region,
      vpcId: values.vpcId,
      provider: 'aws',
    };

    if (!ReactInjector.$state.includes('**.loadBalancerDetails')) {
      ReactInjector.$state.go('.loadBalancerDetails', newStateParams);
    } else {
      ReactInjector.$state.go('^.loadBalancerDetails', newStateParams);
    }
  }

  public componentWillUnmount(): void {
    if (this.refreshUnsubscribe) {
      this.refreshUnsubscribe();
    }
  }

  private onTaskComplete(values: IAmazonClassicLoadBalancerUpsertCommand): void {
    this.props.app.loadBalancers.refresh();
    this.refreshUnsubscribe = this.props.app.loadBalancers.onNextRefresh(null, () => this.onApplicationRefresh(values));
  }

  private submit(values: IAmazonClassicLoadBalancerUpsertCommand): void {
    const { app, forPipelineConfig, onComplete } = this.props;
    const { isNew } = this.state;

    const descriptor = isNew ? 'Create' : 'Update';
    const loadBalancerCommandFormatted = cloneDeep(values);
    if (forPipelineConfig) {
      // don't submit to backend for creation. Just return the loadBalancerCommand object
      this.formatListeners(loadBalancerCommandFormatted).then(() => {
        onComplete && onComplete(loadBalancerCommandFormatted);
      });
    } else {
      const taskMonitor = ReactInjector.taskMonitorBuilder.buildTaskMonitor({
        application: app,
        title: `${isNew ? 'Creating' : 'Updating'} your load balancer`,
        modalInstance: this.$uibModalInstanceEmulation,
        onTaskComplete: () => this.onTaskComplete(loadBalancerCommandFormatted),
      });

      taskMonitor.submit(() => {
        return this.formatListeners(loadBalancerCommandFormatted).then(() => {
          this.formatCommand(loadBalancerCommandFormatted);
          return ReactInjector.loadBalancerWriter.upsertLoadBalancer(loadBalancerCommandFormatted, app, descriptor);
        });
      });

      this.setState({ taskMonitor });
    }
  }

  private validate(values: FormikValues): FormikErrors<IAmazonClassicLoadBalancerUpsertCommand> {
    this.setState({ includeSecurityGroups: !!values.vpcId });
    const errors = {} as FormikErrors<IAmazonClassicLoadBalancerUpsertCommand>;
    return errors;
  }

  public render(): React.ReactElement<CreateClassicLoadBalancer> {
    const { app, forPipelineConfig, loadBalancer, show } = this.props;
    const { includeSecurityGroups, isNew, loadBalancerCommand, taskMonitor } = this.state;

    if (!show) {
      return null;
    }

    const hideSections = new Set<string>();

    if (!isNew && !forPipelineConfig) {
      hideSections.add(LoadBalancerLocation.label);
    }

    if (!includeSecurityGroups) {
      hideSections.add(SecurityGroups.label);
    }

    let heading = forPipelineConfig ? 'Configure Classic Load Balancer' : 'Create New Classic Load Balancer';
    if (!isNew) {
      heading = `Edit ${loadBalancerCommand.name}: ${loadBalancerCommand.region}: ${loadBalancerCommand.credentials}`;
    }

    return (
      <ClassicLoadBalancerModal
        heading={heading}
        initialValues={loadBalancerCommand}
        taskMonitor={taskMonitor}
        dismiss={this.dismiss}
        show={show}
        submit={this.submit}
        submitButtonLabel={forPipelineConfig ? (isNew ? 'Add' : 'Done') : isNew ? 'Create' : 'Update'}
        validate={this.validate}
        hideSections={hideSections}
      >
        <LoadBalancerLocation
          app={app}
          isNew={isNew}
          forPipelineConfig={forPipelineConfig}
          loadBalancer={loadBalancer}
        />
        <SecurityGroups done={true} />
        <Listeners done={true} />
        <HealthCheck done={true} />
        <AdvancedSettings done={true} />
      </ClassicLoadBalancerModal>
    );
  }
}
